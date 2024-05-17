import { uniqBy } from 'lodash-es';

export const getRandom = <T>(array: T[]) => array[Math.floor(Math.random() * array.length)];

/**
 * @example Transform from ['Apple', 'Banana', 'Orange'] to "Apple, Banana and Orange"
 */
export function toStringList(array: string[]) {
  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  return formatter.format(array);
}

export function removeDuplicates<T extends object>(array: T[], property: keyof T) {
  return uniqBy<T>(array, property);
}

export function sortAlphabetically<T>(array: T[]) {
  return array.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}
export function sortAlphabeticallyBy<T>(array: T[], fn: (item: T) => string) {
  return array.sort((...args) => {
    const a = fn(args[0]);
    const b = fn(args[1]);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export function indexOfOr<T>(array: T[], value: T, or: number) {
  const index = array.indexOf(value);
  return index === -1 ? or : index;
}

export function shuffle<T>(array: T[]) {
  return array.sort(() => Math.random() - 0.5);
}

export function insertSorted(arr: number[], toInsert: number, order: 'asc' | 'desc' = 'asc') {
  let left = 0;
  let right = arr.length;

  // Binary search to find the correct insertion point
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if ((order === 'asc' && arr[mid] < toInsert) || (order === 'desc' && arr[mid] > toInsert)) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Insert at the correct position
  arr.splice(left, 0, toInsert);
}
