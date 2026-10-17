/** Current two-level addresses and legacy three-level addresses are never mixed. */
export type GeographyMode = 'current' | 'legacy';

/** Names persisted with an address; district is absent in the current hierarchy. */
export interface AddressGeographyValue {
  province?: string;
  district?: string;
  ward?: string;
}

/** A verified selection, including whether every unit belongs to its selected parent. */
export interface AddressGeographySelection extends AddressGeographyValue {
  province: string;
  district: string;
  ward: string;
  mode: GeographyMode;
  valid: boolean;
}

/** Administrative unit from the attributed snapshot, with its authoritative code. */
export interface GeographyUnit {
  code: number;
  name: string;
  wards?: GeographyUnit[];
  districts?: GeographyUnit[];
}

/** Versioned public data served by Velura, without a runtime third-party dependency. */
export interface GeographyDataset {
  mode: GeographyMode;
  source: string;
  retrieved_at: string;
  provinces: GeographyUnit[];
}
