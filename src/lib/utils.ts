import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges Tailwind class names, resolving conflicts so the LAST conflicting class wins.
 *
 * Plain string concatenation does not do this: `"p-2 p-4"` leaves both classes in the
 * DOM and the winner is decided by their order in the generated stylesheet, not by the
 * order you wrote them — so a variant trying to override a base style silently fails
 * about half the time. `twMerge` drops the losing class outright.
 *
 * Every component in `src/components/ui/` composes its classes through this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
