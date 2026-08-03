import type { BoundingBox, DocumentRegion, RegionType } from '@pdfreader/shared-types';
import { joinWrappedLines } from '@/features/extraction/normalize';
import type { LayoutBlock, PageLayout } from '@/features/extraction/types';
import { detectRepeatedRegions, type PageBlocks } from './repeated';
import { detectPageNumbers } from './page-numbers';
import { detectReferenceSections, type OrderedBlock } from './references';
import { detectWatermarks } from './watermarks';
import { detectFrontMatter } from './front-matter';

/**
 * Combines every detector into a single set of DocumentRegions.
 *
 * The pipeline is additive and conservative: detectors propose a type with a
 * confidence and a list of evidence strings; the highest-confidence proposal
 * wins, and the losing proposals are still recorded as evidence so the Content
 * Review panel can explain the decision. No text is deleted at this stage —
 * inclusion is decided later by the reading mode.
 */

export interface ClassifyInput {
  documentId: string;
  pages: PageLayout[];
  bodyFontSize: number;
}

interface Proposal {
  type: RegionType;
  confidence: number;
  evidence: string[];
  source: string;
}

/** Region text, reconstructed the same way the spoken text is. */
export function regionText(block: LayoutBlock): string {
  return joinWrappedLines(
    block.lines.map((line) => ({
      text: line.text,
      sourceTextItemIds: line.items.map((item) => item.id),
      spans: line.spans,
    })),
  ).text.trim();
}

function boundingBoxes(block: LayoutBlock): BoundingBox[] {
  return block.lines.map((line) => ({
    pageNumber: line.pageNumber,
    x: line.x,
    y: line.baseline,
    width: line.width,
    height: line.height,
  }));
}

export function classifyDocument(input: ClassifyInput): DocumentRegion[] {
  const { documentId, pages, bodyFontSize } = input;

  const pageBlocks: PageBlocks[] = pages.map((page) => ({
    pageNumber: page.pageNumber,
    pageHeight: page.height,
    pageWidth: page.width,
    blocks: page.blocks,
    bodyFontSize: page.bodyFontSize || bodyFontSize,
  }));

  const ordered: OrderedBlock[] = [];
  let order = 0;
  for (const page of pages) {
    for (const block of page.blocks) {
      ordered.push({ block, pageNumber: page.pageNumber, order: order++ });
    }
  }

  const repeated = detectRepeatedRegions(pageBlocks);
  const pageNumbers = detectPageNumbers(pageBlocks);
  const references = detectReferenceSections(ordered, bodyFontSize);
  const watermarks = detectWatermarks(pageBlocks, bodyFontSize);
  const frontMatter = detectFrontMatter(ordered, pageBlocks);

  const regions: DocumentRegion[] = [];

  for (const entry of ordered) {
    const { block } = entry;
    const proposals: Proposal[] = [];

    // The layout stage's own opinion is always a proposal, never a given.
    proposals.push({
      type: block.type,
      confidence: block.confidence,
      evidence: block.evidence,
      source: 'layout analysis',
    });

    const repeatedFinding = repeated.get(block.id);
    if (repeatedFinding) {
      proposals.push({
        type: repeatedFinding.type,
        confidence: repeatedFinding.confidence,
        evidence: repeatedFinding.evidence,
        source: 'repeated-region detection',
      });
    }

    const pageNumberFinding = pageNumbers.get(block.id);
    if (pageNumberFinding) {
      proposals.push({
        type: 'page-number',
        confidence: pageNumberFinding.confidence,
        evidence: pageNumberFinding.evidence,
        source: 'page-number detection',
      });
    }

    const referenceFinding = references.get(block.id);
    if (referenceFinding) {
      proposals.push({
        type: referenceFinding.type,
        confidence: referenceFinding.confidence,
        evidence: referenceFinding.evidence,
        source: 'reference-section detection',
      });
    }

    const watermarkFinding = watermarks.get(block.id);
    if (watermarkFinding) {
      proposals.push({
        type: 'watermark',
        confidence: watermarkFinding.confidence,
        evidence: watermarkFinding.evidence,
        source: 'watermark detection',
      });
    }

    // A standalone page number is also, trivially, a repeated footer. When both
    // detectors fire, prefer the more specific classification: it is the more
    // accurate description and it maps to a finer-grained Custom Mode category.
    const moreSpecific = pageNumberFinding
      ? proposals.find((proposal) => proposal.type === 'page-number')
      : undefined;

    proposals.sort((a, b) => b.confidence - a.confidence);
    const winner = moreSpecific ?? proposals[0];
    const evidence = proposals.flatMap((proposal) =>
      proposal.evidence.map(
        (line) => `[${proposal.source}, ${Math.round(proposal.confidence * 100)}%] ${line}`,
      ),
    );

    if (frontMatter.has(block.id)) {
      evidence.push(`[front-matter detection] ${frontMatter.get(block.id)}`);
    }

    regions.push({
      id: block.id,
      documentId,
      pageNumber: block.pageNumber,
      type: winner.type,
      confidence: winner.confidence,
      textItemIds: block.lines.flatMap((line) => line.items.map((item) => item.id)),
      boundingBoxes: boundingBoxes(block),
      // Filled in by applyReadingMode; every region starts included so that a
      // bug in the mode layer can never silently drop content.
      included: true,
      inclusionReason: 'Not yet evaluated against a reading mode.',
      classificationEvidence: evidence,
      columnIndex: block.columnIndex,
      readingOrder: entry.order,
      // Uses the same wrap/hyphen reconstruction as the spoken text, so what the
      // Content Review panel shows is exactly what would be read.
      text: regionText(block),
      orderUncertain:
        block.orderUncertain ||
        pages.find((p) => p.pageNumber === block.pageNumber)?.readingOrderUncertain,
    });
  }

  return regions;
}

/** Region ids that belong to detected front matter, for the Custom Mode category. */
export { detectFrontMatter } from './front-matter';
