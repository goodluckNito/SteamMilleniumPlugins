/**
 * Injected by Millennium into Steam's web views (store, community, ...).
 * We only act on the Steam News Hub: store.steampowered.com/news/...
 */
import { pluginConfig, subscribePluginConfig } from 'millennium';
import { debug, start, updateSettings } from './dedupe';
import { DEFAULT_SETTINGS, SETTING_KEYS, type DedupeSettings } from '../shared/settings';

function isNewsPage(): boolean {
	return location.hostname === 'store.steampowered.com' && /^\/(news|events)(\/|$)/i.test(location.pathname);
}

async function loadSettings(): Promise<DedupeSettings> {
	const out: DedupeSettings = { ...DEFAULT_SETTINGS };
	await Promise.all(
		SETTING_KEYS.map(async (key) => {
			try {
				const v = await pluginConfig.get<boolean>(key);
				if (typeof v === 'boolean') out[key] = v;
			} catch {
				/* keep default */
			}
		}),
	);
	return out;
}

export default async function main() {
	if (!isNewsPage()) return;

	(window as any).__newsDedupe = debug;
	// Start right away with defaults so nothing flashes, then apply saved settings.
	start();
	updateSettings(await loadSettings());

	try {
		subscribePluginConfig((key: string, value: unknown) => {
			if ((SETTING_KEYS as string[]).includes(key) && typeof value === 'boolean') {
				updateSettings({ [key]: value } as Partial<DedupeSettings>);
			}
		});
	} catch {
		/* live updates are optional; settings apply on next page load anyway */
	}
}
