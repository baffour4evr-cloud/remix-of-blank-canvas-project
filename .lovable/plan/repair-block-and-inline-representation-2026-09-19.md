# Repair block and inline representation

## Scope

Repair ONLY the normalized-document-model → reader representation.

Do NOT modify:

- PDF extraction

- OCR

- Unicode repair

- structure detection

- paragraph reconstruction algorithms

- reference detection/resolution

- reference heuristics

- sidebar

- popup

- reader styling

The goal is to ensure that semantic inline content is rendered as inline content rather than being incorrectly converted into independent reader blocks.

## Implementation

### 1. Introduce an explicit inline representation

For every semantic block that can contain flowing text, derive an ordered inline sequence from its existing normalized runs.

Supported inline types should include, where already represented by the normalized model:

- Text

- Emphasis

- Strong emphasis

- Small caps

- Superscript

- Subscript

- Hyperlink

- ReferenceMarker

- other existing inline semantic annotations

Every inline node MUST retain:

- exact text

- source-span provenance

- source range

- semantic type

- existing formatting information

Do not create new semantic types unless required by the existing model.

### 2. Preserve semantic boundaries

Split inline runs whenever an existing semantic boundary requires it, including:

- formatting changes

- emphasis changes

- superscript/subscript

- hyperlink ranges

- reference-marker ranges

- other existing inline annotations

A ReferenceMarker or hyperlink MUST remain an inline child of its containing paragraph/verse line.

It must NEVER become a reader-level block merely because it has its own metadata or source bounding box.

For example:

`Elizabeth's sense and conduct[6]`

must remain one flowing paragraph with `[6]` represented as an inline child/range.

Likewise:

`(1.136–40)`

must remain inline with its surrounding text.

### 3. Preserve exact text

The concatenation of inline text nodes for a semantic block must reproduce the semantic block's existing text exactly.

Do not:

- add spaces

- remove spaces

- move punctuation

- move reference markers

- merge words

- split words

- normalize text differently

- reinterpret Unicode

This task is a representation change, not a text-correction task.

### 4. One reader block per semantic block

The reader should render:

Semantic Paragraph

→ one reader block

→ ordered inline children

Semantic VerseLine

→ one reader line

→ ordered inline children

Semantic Heading

→ one heading block

→ ordered inline children

etc.

Do NOT create reader blocks from PDF coordinates, bounding boxes, font changes, or source-span boundaries.

PDF coordinates are provenance only at this layer.

### 5. Do not perform paragraph reconstruction here

Do NOT join or split paragraphs based on physical PDF line/span boundaries in this task.

The normalized semantic model is authoritative.

If the normalized model contains:

Paragraph A

Paragraph B

the reader must render two paragraphs.

If the normalized model contains one paragraph composed from multiple source spans, the reader must render one paragraph.

Do not introduce a second paragraph-reconstruction algorithm in the reader.

## Tests

Add focused model-to-reader tests proving:

1. Continuous prose remains one reader block.

2. Multiple source spans belonging to one paragraph remain one reader block.

3. `[6]` remains an inline ReferenceMarker.

4. `(1.136–40)` remains inline.

5. Hyperlinks remain inline.

6. Italic/bold/superscript remain inline.

7. A reference marker does not become a separate block.

8. A hyperlink does not become a separate block.

9. Genuine paragraph boundaries already present in the normalized model remain intact.

10. Headings remain blocks.

11. Verse lines remain separate semantic blocks.

12. Inline text concatenation exactly equals the normalized source text.

13. Source-span provenance survives the transformation.

## Regression protection

Do not modify reference detection to make these tests pass.

Do not add book-specific rules.

Do not add PDF-specific coordinate heuristics.

Do not change extraction or OCR.

Run the complete test suite and build the application.

Report:

- the existing normalized representation before the change

- the new reader representation

- any files changed

- test results

STOP after this task.