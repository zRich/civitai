import { Group, GroupProps } from '@mantine/core';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function BountyFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="bounties" variant="button" />
      {/* // TODO.justin: adjust the background color */}
      <BountyFiltersDropdown size="sm" compact />
    </Group>
  );
}
