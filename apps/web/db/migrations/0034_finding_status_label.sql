ALTER TABLE finding_status ADD COLUMN IF NOT EXISTS label text DEFAULT 'blocking';
UPDATE finding_status SET label = 'blocking' WHERE label IS NULL;
