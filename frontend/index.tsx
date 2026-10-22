import { definePlugin, Field, Toggle, usePluginConfig } from 'millennium';
import { DEFAULT_SETTINGS, SETTING_KEYS, type DedupeSettings } from '../shared/settings';

const LABELS: Record<keyof DedupeSettings, { label: string; description: string }> = {
	enabled: {
		label: 'Hide duplicate news posts',
		description: 'When the same post is published for several games, only the first one is shown in the News Hub.',
	},
	titleOnly: {
		label: 'Aggressive matching (title only)',
		description: 'Merge any posts that share a title. Off = the body text must also match, or they must be posted within 3 days of each other.',
	},
	showBadge: {
		label: 'Show "+N duplicates" badge',
		description: 'Adds a small pill to the post that was kept. Click it to show or hide the merged copies.',
	},
};

/** One toggle bound to one key of the plugin's persisted config (shared with the webview script). */
const SettingToggle = ({ name, disabled }: { name: keyof DedupeSettings; disabled?: boolean }) => {
	const [stored, setStored] = usePluginConfig<boolean>(name);
	const checked = typeof stored === 'boolean' ? stored : DEFAULT_SETTINGS[name];
	return (
		<Field label={LABELS[name].label} description={LABELS[name].description} disabled={disabled}>
			<Toggle
				value={checked}
				disabled={disabled}
				onChange={(v: boolean) => {
					setStored(v).catch((e: unknown) => console.error('[NewsDedupe] failed to save setting', name, e));
				}}
			/>
		</Field>
	);
};

const SettingsContent = () => {
	const [enabled] = usePluginConfig<boolean>('enabled');
	const isEnabled = typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled;
	return (
		<>
			{SETTING_KEYS.map((key) => (
				<SettingToggle key={key} name={key} disabled={key !== 'enabled' && !isEnabled} />
			))}
			<Field
				label="Tip"
				description="Changes apply immediately in the News Hub. If they don't, reload the page (F5)."
				bottomSeparator="none"
			/>
		</>
	);
};

const Icon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
		<rect x="8" y="8" width="13" height="13" rx="2" />
		<path d="M4 16V5a1 1 0 0 1 1-1h11" />
	</svg>
);

export default definePlugin(() => {
	return {
		title: 'Steam News Dedupe',
		icon: <Icon />,
		content: <SettingsContent />,
	};
});
