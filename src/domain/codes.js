// Document codes: a fixed prefix plus a zero-padded sequence, following the
// convention already in use in the sibling app (EG-0001).
//
// Pure — the caller supplies the next sequence number, this only formats it.

export const CODE_FORMATS = {
  farmer:      { prefix: 'FRM', width: 4 },
  parcel:      { prefix: 'PCL', width: 4 },
  contract:    { prefix: 'CTR', width: 4 },
  lot:         { prefix: 'LOT', width: 4 },
  input_issue: { prefix: 'ISS', width: 5 },
  delivery:    { prefix: 'GRN', width: 5 },
  quality_test:{ prefix: 'QT',  width: 5 },
  settlement:  { prefix: 'STL', width: 5 },
  payment:     { prefix: 'PMT', width: 5 },
};

export function formatCode(entity, sequence) {
  const fmt = CODE_FORMATS[entity];
  if (!fmt) throw new RangeError(`no code format for entity ${entity}`);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError('sequence must be a positive integer');
  }
  return `${fmt.prefix}-${String(sequence).padStart(fmt.width, '0')}`;
}

/** Export filename convention: BRAND-entity-YYYY-MM-DD.csv */
export function exportFilename(brand, entity, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new RangeError('isoDate must be YYYY-MM-DD');
  return `${brand}-${entity}-${isoDate}.csv`;
}
