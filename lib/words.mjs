// Word counting for the host's length limits.
// Uses Intl word segmentation so Chinese and other unspaced text count by word, as upstream does.

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export function countWords(text) {
  let count = 0
  for (const part of segmenter.segment(String(text ?? ''))) {
    if (part.isWordLike) count++
  }
  return count
}

export function assertWordLimit(text, limit, label) {
  const words = countWords(text)
  if (words > limit) {
    throw new UserError(`${label} has ${words} words; the limit is ${limit}. Shorten it, do not split it.`)
  }
}

export class UserError extends Error {}
