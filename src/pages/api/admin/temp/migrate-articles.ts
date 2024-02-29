import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const batchSize = 10000;
export default WebhookEndpoint(async (req, res) => {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  console.log('start');
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Post";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Post" WHERE "nsfwLevel" = 0;`
  );

  let cursor = min ?? 0;
  console.log(cursor > maxId);
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating articles ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON (a.id) a.id, bit_or(i."nsfwLevel") "nsfwLevel"
          FROM "Article" a
          JOIN "Image" i ON a."coverId" = i.id
          WHERE a.id BETWEEN ${start} AND ${end} AND a."nsfwLevel" = 0
          GROUP BY a.id
        )
        UPDATE "Article" a
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = a.id;
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  // TODO.nsfwLevel - delete posts with no images not attached to a modelVersion?
  // delete from "Post" where "nsfwLevel" = 0 AND "modelVersionId" is null

  console.log('end');
  res.status(200).json({ finished: true });
});
