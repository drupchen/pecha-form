/**
 * Minimal typings for `tibetan-ewts-converter` (rogerespel/ewts-js, Apache-2.0) —
 * the THL / Lotsawa House phonetics + EWTS engine. The package ships no types; we
 * declare only the surface Phase P uses.
 */
declare module 'tibetan-ewts-converter' {
  export interface PhoneticsOptions {
    joiner?: string;
    separator?: string;
    autosplit?: boolean;
    caps?: boolean;
    clear_warnings?: boolean;
  }
  export interface PhoneticsEngine {
    phonetics(input: string, opts?: PhoneticsOptions): string;
  }
  export interface GetPhoneticsOptions {
    style?: 'thl' | 'lotsawahouse' | 'rigpa' | 'padmakara' | 'lhasey';
    lang?: string;
    [key: string]: unknown;
  }
  export function get_phonetics(opts?: GetPhoneticsOptions): PhoneticsEngine;

  export class EwtsConverter {
    constructor(opts?: Record<string, unknown>);
    to_ewts(input: string): string;
    to_unicode(input: string, keep?: unknown): string;
  }
}
