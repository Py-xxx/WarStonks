import type { MarketVariant } from '../types';

export function orderQuickViewVariants(variants: MarketVariant[]): MarketVariant[] {
  if (variants.length <= 1) {
    return [...variants];
  }

  const defaultVariant =
    variants.find((variant) => variant.isDefault) ??
    variants[0];
  const remaining = variants.filter((variant) => variant.key !== defaultVariant.key);

  remaining.sort((left, right) => {
    const leftRank = left.rank ?? Number.NEGATIVE_INFINITY;
    const rightRank = right.rank ?? Number.NEGATIVE_INFINITY;
    if (rightRank !== leftRank) {
      return rightRank - leftRank;
    }
    return left.label.localeCompare(right.label);
  });

  return [defaultVariant, ...remaining];
}

