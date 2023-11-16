import { GetByIdInput } from '~/server/schema/base.schema';
import {
  BulkDeleteGeneratedImagesInput,
  CheckResourcesCoverageSchema,
  CreateGenerationRequestInput,
  GetGenerationDataInput,
  GetGenerationRequestsOutput,
  GetGenerationResourcesInput,
  PrepareModelInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
  withRetries,
} from '~/server/utils/errorHandling';
import { ModelType, Prisma } from '@prisma/client';
import {
  GenerationResourceSelect,
  generationResourceSelect,
} from '~/server/selectors/generation.selector';
import { Generation, GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { isDefined } from '~/utils/type-guards';
import { QS } from '~/utils/qs';
import { env } from '~/env/server.mjs';

import {
  BaseModel,
  baseModelSets,
  BaseModelSetType,
  getGenerationConfig,
  Sampler,
} from '~/server/common/constants';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { uniqBy } from 'lodash-es';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { calculateGenerationBill } from '~/server/common/generation';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';
import { redis } from '~/server/redis/client';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// when removing a string from the `safeNegatives` array, add it to the `allSafeNegatives` array
const safeNegatives = [{ id: 106916, triggerWord: 'civit_nsfw' }];
const allSafeNegatives = [...safeNegatives];

function mapRequestStatus(label: string): GenerationRequestStatus {
  switch (label) {
    case 'Pending':
      return GenerationRequestStatus.Pending;
    case 'Processing':
      return GenerationRequestStatus.Processing;
    case 'Cancelled':
      return GenerationRequestStatus.Cancelled;
    case 'Error':
      return GenerationRequestStatus.Error;
    case 'Succeeded':
      return GenerationRequestStatus.Succeeded;
    default:
      throw new Error(`Invalid status label: ${label}`);
  }
}

function mapGenerationResource(
  resource: GenerationResourceSelect & { settings?: RecommendedSettingsSchema | null }
): Generation.Resource {
  const { model, settings, ...x } = resource;
  return {
    id: x.id,
    name: x.name,
    trainedWords: x.trainedWords,
    modelId: model.id,
    modelName: model.name,
    modelType: model.type,
    baseModel: x.baseModel,
    strength: settings?.strength ?? 1,
    minStrength: settings?.minStrength ?? -1,
    maxStrength: settings?.maxStrength ?? 2,
  };
}

const baseModelSetsArray = Object.values(baseModelSets);
export const getGenerationResources = async ({
  take,
  query,
  types,
  notTypes,
  ids, // used for getting initial values of resources
  baseModel,
  user,
  supported,
}: GetGenerationResourcesInput & { user?: SessionUser }): Promise<Generation.Resource[]> => {
  const preselectedVersions: number[] = [];
  if (!ids && !query) {
    const featuredCollection = await dbRead.collection
      .findFirst({
        where: { userId: -1, name: 'Generator' },
        select: {
          items: {
            select: {
              model: {
                select: {
                  name: true,
                  type: true,
                  modelVersions: {
                    select: { id: true, name: true },
                    where: { status: 'Published' },
                    orderBy: { index: 'asc' },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      })
      .catch(() => null);

    if (featuredCollection)
      preselectedVersions.push(
        ...featuredCollection.items.flatMap((x) => x.model?.modelVersions.map((x) => x.id) ?? [])
      );

    ids = preselectedVersions;
  }

  const sqlAnd = [Prisma.sql`mv.status = 'Published' AND m.status = 'Published'`];
  if (ids && ids.length > 0) sqlAnd.push(Prisma.sql`mv.id IN (${Prisma.join(ids, ',')})`);
  if (!!types?.length)
    sqlAnd.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types, ',')}]::"ModelType"[])`);
  if (!!notTypes?.length)
    sqlAnd.push(Prisma.sql`m.type != ANY(ARRAY[${Prisma.join(notTypes, ',')}]::"ModelType"[])`);
  if (query) {
    const pgQuery = '%' + query + '%';
    sqlAnd.push(Prisma.sql`m.name ILIKE ${pgQuery}`);
  }
  if (baseModel) {
    const baseModelSet = baseModelSetsArray.find((x) => x.includes(baseModel as BaseModel));
    if (baseModelSet)
      sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet, ',')})`);
  }

  let orderBy = 'mv.index';
  if (!query) orderBy = `mr."ratingAllTimeRank", ${orderBy}`;

  const results = await dbRead.$queryRaw<Array<Generation.Resource & { index: number }>>`
    SELECT
      mv.id,
      mv.index,
      mv.name,
      mv."trainedWords",
      m.id "modelId",
      m.name "modelName",
      m.type "modelType",
      mv."baseModel"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    ${Prisma.raw(
      supported
        ? `JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id AND gc.covered = true`
        : ''
    )}
    ${Prisma.raw(orderBy.startsWith('mr') ? `LEFT JOIN "ModelRank" mr ON mr."modelId" = m.id` : '')}
    WHERE ${Prisma.join(sqlAnd, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${take}
  `;

  return results.map((resource) => ({
    ...resource,
    strength: 1,
  }));
};

const CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const getResourceData = async (modelVersionIds: number[]) => {
  if (modelVersionIds.length === 0) return [];

  const results = new Set<GenerationResourceSelect>();
  const cacheJsons = await redis.hmGet('generation:resource-data', modelVersionIds.map(String));
  const cacheArray = cacheJsons.filter((x) => x !== null).map((x) => JSON.parse(x));
  const cache = Object.fromEntries(cacheArray.map((x) => [x.id, x]));

  const cacheCutoff = Date.now() - CACHE_TTL;
  const cacheMisses = new Set<number>();
  for (const id of modelVersionIds) {
    const cached = cache[id];
    if (cached && cached.cachedAt > cacheCutoff) results.add(cached);
    else cacheMisses.add(id);
  }

  // If we have cache misses, we need to fetch from the DB
  if (cacheMisses.size > 0) {
    const dbResults = await dbRead.modelVersion.findMany({
      where: { id: { in: [...cacheMisses] } },
      select: generationResourceSelect,
    });

    const toCache: Record<string, string> = {};
    const cachedAt = Date.now();
    for (const result of dbResults) {
      results.add(result);
      toCache[result.id] = JSON.stringify({ ...result, cachedAt });
    }

    // then cache the results
    if (Object.keys(toCache).length > 0) await redis.hSet('generation:resource-data', toCache);
  }

  return [...results];
};

const baseModelSetsEntries = Object.entries(baseModelSets);
const formatGenerationRequests = async (requests: Generation.Api.RequestProps[]) => {
  const modelVersionIds = requests
    .map((x) => parseModelVersionId(x.job.model))
    .concat(
      requests.flatMap((x) => Object.keys(x.job.additionalNetworks ?? {}).map(parseModelVersionId))
    )
    .filter((x) => x !== null) as number[];

  const modelVersions = await getResourceData(modelVersionIds);

  const checkpoint = modelVersions.find((x) => x.model.type === 'Checkpoint');
  const baseModel = checkpoint
    ? (baseModelSetsEntries.find(([, v]) =>
        v.includes(checkpoint.baseModel as BaseModel)
      )?.[0] as BaseModelSetType)
    : undefined;

  return requests.map((x): Generation.Request => {
    const { additionalNetworks = {}, params, ...job } = x.job;

    let assets = [x.job.model, ...Object.keys(x.job.additionalNetworks ?? {})];

    // scrub negative prompt
    let negativePrompt = params.negativePrompt ?? '';
    for (const { triggerWord, id } of allSafeNegatives) {
      negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
      assets = assets.filter((x) => x !== `@civitai/${id}`);
    }

    return {
      id: x.id,
      createdAt: x.createdAt,
      estimatedCompletionDate: x.estimatedCompletedAt,
      status: mapRequestStatus(x.status),
      queuePosition: x.queuePosition,
      params: {
        ...params,
        baseModel,
        negativePrompt,
        seed: params.seed === -1 ? undefined : params.seed,
      },
      resources: assets
        .map((assetId): Generation.Resource | undefined => {
          const modelVersionId = parseModelVersionId(assetId);
          const modelVersion = modelVersions.find((x) => x.id === modelVersionId);
          const network = x.job.additionalNetworks?.[assetId] ?? {};
          if (!modelVersion) return undefined;
          const { model } = modelVersion;
          return {
            id: modelVersion.id,
            name: modelVersion.name,
            trainedWords: modelVersion.trainedWords,
            modelId: model.id,
            modelName: model.name,
            modelType: model.type,
            baseModel: modelVersion.baseModel,
            ...network,
          };
        })
        .filter(isDefined),
      ...job,
      images: x.images,
    };
  });
};

export type GetGenerationRequestsReturn = AsyncReturnType<typeof getGenerationRequests>;
export const getGenerationRequests = async (
  props: GetGenerationRequestsOutput & { userId: number }
) => {
  const params = QS.stringify(props);
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { cursor, requests }: Generation.Api.Request = await response.json();

  const items = await formatGenerationRequests(requests);

  return { items, nextCursor: cursor === 0 ? undefined : cursor ?? undefined };
};

const samplersToSchedulers: Record<Sampler, string> = {
  'Euler a': 'EulerA',
  Euler: 'Euler',
  LMS: 'LMS',
  Heun: 'Heun',
  DPM2: 'DPM2',
  'DPM2 a': 'DPM2A',
  'DPM++ 2S a': 'DPM2SA',
  'DPM++ 2M': 'DPM2M',
  'DPM++ 2M SDE': 'DPM2MSDE',
  'DPM++ SDE': 'DPMSDE',
  'DPM fast': 'DPMFast',
  'DPM adaptive': 'DPMAdaptive',
  'LMS Karras': 'LMSKarras',
  'DPM2 Karras': 'DPM2Karras',
  'DPM2 a Karras': 'DPM2AKarras',
  'DPM++ 2S a Karras': 'DPM2SAKarras',
  'DPM++ 2M Karras': 'DPM2MKarras',
  'DPM++ 2M SDE Karras': 'DPM2MSDEKarras',
  'DPM++ SDE Karras': 'DPMSDEKarras',
  DDIM: 'DDIM',
  PLMS: 'PLMS',
  UniPC: 'UniPC',
};

const baseModelToOrchestration: Record<BaseModelSetType, string | undefined> = {
  SD1: 'SD_1_5',
  SD2: undefined,
  SDXL: 'SDXL',
  SDXLDistilled: 'SDXL_Distilled',
};

async function isAvailableForGeneration(resources: CreateGenerationRequestInput['resources']) {
  const data = await getResourceData(resources.map((x) => x.id));

  return data.every((x) => !!x.generationCoverage?.covered);
}

export const createGenerationRequest = async ({
  userId,
  resources,
  params: { nsfw, negativePrompt, ...params },
}: CreateGenerationRequestInput & { userId: number }) => {
  if (!resources || resources.length === 0) throw throwBadRequestError('No resources provided');
  if (resources.length > 10) throw throwBadRequestError('Too many resources provided');

  const allResourcesAvailable = await isAvailableForGeneration(resources).catch(() => false);
  if (!allResourcesAvailable)
    throw throwBadRequestError('Some of your resources are not available for generation');

  const isSDXL = params.baseModel === 'SDXL';
  const checkpoint = resources.find((x) => x.modelType === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');

  const { additionalResourceTypes, aspectRatios } = getGenerationConfig(params.baseModel);
  if (params.aspectRatio.includes('x'))
    throw throwBadRequestError('Invalid size. Please select your size and try again');
  const { height, width } = aspectRatios[Number(params.aspectRatio)];

  // const additionalResourceTypes = getGenerationConfig(params.baseModel).additionalResourceTypes;

  const additionalNetworks = resources
    .filter((x) => additionalResourceTypes.map((x) => x.type).includes(x.modelType as any))
    .reduce((acc, { id, modelType, ...rest }) => {
      acc[`@civitai/${id}`] = { type: modelType, ...rest };
      return acc;
    }, {} as { [key: string]: object });

  const negativePrompts = [negativePrompt ?? ''];
  if (!nsfw && !isSDXL) {
    for (const { id, triggerWord } of safeNegatives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      negativePrompts.unshift(triggerWord);
    }
  }

  const vae = resources.find((x) => x.modelType === ModelType.VAE);
  if (vae && !isSDXL) {
    additionalNetworks[`@civitai/${vae.id}`] = {
      type: ModelType.VAE,
    };
  }

  const generationRequest = {
    userId,
    job: {
      model: `@civitai/${checkpoint.id}`,
      baseModel: baseModelToOrchestration[params.baseModel as BaseModelSetType],
      quantity: params.quantity,
      additionalNetworks,
      params: {
        prompt: params.prompt,
        negativePrompt: negativePrompts.join(', '),
        scheduler: samplersToSchedulers[params.sampler as Sampler],
        steps: params.steps,
        cfgScale: params.cfgScale,
        height,
        width,
        seed: params.seed,
        clipSkip: params.clipSkip,
      },
    },
  };

  // console.log('________');
  // console.log(JSON.stringify(generationRequest));
  // console.log('________');

  const totalCost = calculateGenerationBill({
    baseModel: params.baseModel,
    quantity: params.quantity,
    steps: params.steps,
    aspectRatio: params.aspectRatio,
  });

  const buzzTransaction =
    totalCost > 0
      ? await createBuzzTransaction({
          fromAccountId: userId,
          type: TransactionType.Generation,
          amount: totalCost,
          details: {
            resources,
            params,
          },
          toAccountId: 0,
          description: 'Image generation',
        })
      : undefined;

  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(generationRequest),
  });

  // console.log('________');
  // console.log(response);
  // console.log('________');

  if (response.status === 429) {
    // too many requests
    throw throwRateLimitError();
  }

  if (!response.ok) {
    if (buzzTransaction) {
      await withRetries(async () =>
        refundTransaction(
          buzzTransaction.transactionId,
          'Refund due to an error submitting the training job.'
        )
      );
    }

    const message = await response.json();
    throw throwBadRequestError(message);
  }
  const data: Generation.Api.RequestProps = await response.json();
  const [formatted] = await formatGenerationRequests([data]);
  return formatted;
};

export async function getGenerationRequestById({ id }: GetByIdInput) {
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
  if (!response) throw throwNotFoundError();

  const data: Generation.Api.RequestProps = await response.json();
  const [request] = await formatGenerationRequests([data]);
  return request;
}

export async function deleteGenerationRequest({ id, userId }: GetByIdInput & { userId: number }) {
  const getResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
  if (!getResponse) throw throwNotFoundError();

  const request: Generation.Api.RequestProps = await getResponse.json();
  if (request.userId !== userId) throw throwAuthorizationError();

  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`, {
    method: 'DELETE',
  });

  if (!deleteResponse.ok) throw throwNotFoundError();
}

export async function deleteGeneratedImage({ id, userId }: GetByIdInput & { userId: number }) {
  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/images/${id}?userId=${userId}`, {
    method: 'DELETE',
  });
  if (!deleteResponse.ok) throw throwNotFoundError();

  return deleteResponse.ok;
}

export async function bulkDeleteGeneratedImages({
  ids,
  userId,
}: BulkDeleteGeneratedImagesInput & { userId: number }) {
  const queryString = QS.stringify({ imageId: ids, userId });
  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/images?${queryString}`, {
    method: 'DELETE',
  });
  if (!deleteResponse.ok) throw throwNotFoundError();

  return deleteResponse.ok;
}

export async function checkResourcesCoverage({ id }: CheckResourcesCoverageSchema) {
  const result = await dbRead.generationCoverage.findFirst({
    where: { modelVersionId: id },
    select: { covered: true },
  });
  return result?.covered ?? false;
}

export async function getGenerationStatusMessage() {
  const { value } =
    (await dbWrite.keyValue.findUnique({
      where: { key: 'generationStatusMessage' },
      select: { value: true },
    })) ?? {};

  return value ? (value as string) : null;
}

export const getGenerationData = async (
  props: GetGenerationDataInput
): Promise<Generation.Data> => {
  switch (props.type) {
    case 'image':
      return await getImageGenerationData(props.id);
    case 'model':
      return await getResourceGenerationData({ modelId: props.id });
    case 'modelVersion':
      return await getResourceGenerationData({ modelVersionId: props.id });
    case 'random':
      return await getRandomGenerationData(props.includeResources);
  }
};

export const getResourceGenerationData = async ({
  modelId,
  modelVersionId,
}: {
  modelId?: number;
  modelVersionId?: number;
}): Promise<Generation.Data> => {
  if (!modelId && !modelVersionId) throw new Error('modelId or modelVersionId required');
  const resource = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId, modelId },
    select: {
      ...generationResourceSelect,
      clipSkip: true,
      vaeId: true,
    },
  });
  if (!resource) throw throwNotFoundError();
  const resources = [resource];
  if (resource.vaeId) {
    const vae = await dbRead.modelVersion.findFirst({
      where: { id: modelVersionId, modelId },
      select: { ...generationResourceSelect, clipSkip: true },
    });
    if (vae) resources.push({ ...vae, vaeId: null });
  }
  const baseModel = baseModelSetsEntries.find(([, v]) =>
    v.includes(resource.baseModel as BaseModel)
  )?.[0] as BaseModelSetType;
  return {
    resources: resources.map(mapGenerationResource),
    params: {
      baseModel,
      clipSkip: resource.clipSkip ?? undefined,
    },
  };
};

const getImageGenerationData = async (id: number): Promise<Generation.Data> => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: {
      meta: true,
      height: true,
      width: true,
    },
  });
  if (!image) throw throwNotFoundError();

  const {
    'Clip skip': legacyClipSkip,
    clipSkip = legacyClipSkip,
    ...meta
  } = imageGenerationSchema.parse(image.meta);

  const resources = await dbRead.$queryRaw<
    Array<Generation.Resource & { covered: boolean; hash?: string }>
  >`
    SELECT
      mv.id,
      mv.name,
      mv."trainedWords",
      mv."baseModel",
      m.id "modelId",
      m.name "modelName",
      m.type "modelType",
      ir."hash",
      gc.covered
    FROM "ImageResource" ir
    JOIN "ModelVersion" mv on mv.id = ir."modelVersionId"
    JOIN "Model" m on m.id = mv."modelId"
    JOIN "GenerationCoverage" gc on gc."modelVersionId" = mv.id
    WHERE ir."imageId" = ${id}
  `;

  const deduped = uniqBy(resources, 'id');

  if (meta.hashes && meta.prompt) {
    for (const [key, hash] of Object.entries(meta.hashes)) {
      if (!['lora:', 'lyco:'].includes(key)) continue;

      // get the resource that matches the hash
      const resource = deduped.find((x) => x.hash === hash);
      if (!resource) continue;

      // get everything that matches <key:{number}>
      const matches = new RegExp(`<${key}:([0-9\.]+)>`, 'i').exec(meta.prompt);
      if (!matches) continue;

      resource.strength = parseFloat(matches[1]);
    }
  }

  const model = deduped.find((x) => x.modelType === 'Checkpoint');
  const baseModel = model
    ? (baseModelSetsEntries.find(([, v]) =>
        v.includes(model.baseModel as BaseModel)
      )?.[0] as BaseModelSetType)
    : undefined;

  return {
    resources: deduped.map((resource) => ({
      ...resource,
      strength: 1,
    })),
    params: {
      ...meta,
      clipSkip,
      height: image.height ?? undefined,
      width: image.width ?? undefined,
      baseModel,
    },
  };
};

export const getRandomGenerationData = async (includeResources?: boolean) => {
  const imageReaction = await dbRead.imageReaction.findFirst({
    where: {
      reaction: { in: ['Like', 'Heart', 'Laugh'] },
      user: { isModerator: true },
      image: { nsfw: 'None', meta: { not: Prisma.JsonNull } },
    },
    select: { imageId: true },
    orderBy: { createdAt: 'desc' },
    skip: Math.floor(Math.random() * 1000),
  });
  if (!imageReaction) throw throwNotFoundError();

  const { resources, params = {} } = await getImageGenerationData(imageReaction.imageId);
  params.seed = undefined;
  return { resources: includeResources ? resources : [], params };
};

export const deleteAllGenerationRequests = async ({ userId }: { userId: number }) => {
  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?userId=${userId}`, {
    method: 'DELETE',
  });

  if (!deleteResponse.ok) throw throwNotFoundError();
};

export async function prepareModelInOrchestrator({ id, baseModel }: PrepareModelInput) {
  const orchestratorBaseModel = baseModel.includes('SDXL') ? 'SDXL' : 'SD_1_5';
  const response = await orchestratorCaller.prepareModel({
    payload: {
      baseModel: orchestratorBaseModel,
      model: `@civitai/${id}`,
      priority: 1,
      providers: ['OctoML', 'OctoMLNext'],
    },
  });

  if (response.status === 429) throw throwRateLimitError();
  if (!response.ok) throw new Error('An unknown error occurred. Please try again later');

  return response.data;
}
