/* tslint:disable */
/* eslint-disable */

/**
 * Parse a .gdtf archive; returns a JSON array of compiled profiles.
 * Throws (JS-side) with a message on failure.
 */
export function parse_gdtf(bytes: Uint8Array): string;

/**
 * Register a compiled profile (JSON) for rendering; returns a handle.
 */
export function register_profile(json: string): number;

/**
 * Render one fixture's heads through a registered profile.
 * `params` is heads × 15 f64 (layout above). Returns the footprint bytes.
 */
export function render(handle: number, params: Float64Array): Uint8Array;

export function unregister_profile(handle: number): void;
