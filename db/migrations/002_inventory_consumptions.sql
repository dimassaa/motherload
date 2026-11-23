-- Inventory adjustments consume batches FIFO but have no stock document, so the
-- original `batch_consumptions.line_id NOT NULL` contract could not record their
-- provenance. Spec 7.2 allows exactly one source per consumption row: a stock
-- document line for issues/transfers, or an inventory line for counts.
ALTER TABLE batch_consumptions ALTER COLUMN line_id DROP NOT NULL;

ALTER TABLE batch_consumptions
  ADD COLUMN inventory_line_id bigint REFERENCES inventory_lines (id) ON DELETE CASCADE;

-- `<>` rather than `=` is deliberate: it rejects both NULLs (no source) and two
-- sources, while a plain equality would pass when both columns are NULL.
ALTER TABLE batch_consumptions
  ADD CONSTRAINT batch_consumptions_single_source
  CHECK ((line_id IS NOT NULL) <> (inventory_line_id IS NOT NULL));

CREATE INDEX batch_consumptions_line_id_idx ON batch_consumptions (line_id);
CREATE INDEX batch_consumptions_inventory_line_id_idx ON batch_consumptions (inventory_line_id);
