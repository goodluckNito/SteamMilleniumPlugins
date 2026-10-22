export interface DedupeSettings {
	/** Master switch. */
	enabled: boolean;
	/**
	 * false (default): posts must share a title AND either the same body text
	 * or be posted within a few days of each other.
	 * true: any posts with the same title are merged.
	 */
	titleOnly: boolean;
	/** Show a small "+N duplicates" pill on the post that was kept. */
	showBadge: boolean;
}

export const DEFAULT_SETTINGS: DedupeSettings = {
	enabled: true,
	titleOnly: false,
	showBadge: true,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof DedupeSettings)[];
