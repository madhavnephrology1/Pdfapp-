/**
 * When to run a provisional extraction pass while a document is still loading.
 *
 * The pipeline is a pure function of the pages it is given, so a prefix of the
 * document can be analysed on its own and the result replaced later. Running a
 * pass costs time proportional to the number of pages in the prefix, so a fixed
 * interval ("every 10 pages") would make a long document quadratic. Doubling
 * keeps the total extra work below one additional full pass however long the
 * document is, while still making the first page readable almost immediately.
 *
 * For a 200-page document this yields passes at 1, 2, 4, 8, 16, 32, 64 and 128
 * pages — 255 page-analyses of extra work against 200 for the final pass.
 */
export function partialMilestones(pageCount: number): number[] {
  const milestones: number[] = [];
  for (let at = 1; at < pageCount; at *= 2) milestones.push(at);
  return milestones;
}
