/**
 * Core de-duplication logic for the Steam News Hub.
 *
 * How it works
 * ------------
 * 1. Event metadata. The News Hub loads its feed from a few JSON endpoints
 *    under /events/. We watch the page's network activity through the
 *    Performance API (works no matter when this script is injected, and never
 *    touches the page's own fetch/XHR), re-read those responses, and build:
 *      - gid -> clan id     (from "documents" lists)
 *      - gid -> event info  (title, body, time; from "events" lists)
 *    Any card whose details we still lack is looked up in small batches.
 *
 * 2. The DOM. Every feed card contains a link like
 *      /news/app/<appid>/view/<gid>   or   /news/group/<clanid>/view/<gid>
 *    We find the card element around that link, group cards whose events are
 *    duplicates, keep the first one (newest / top-most) and hide the rest.
 */

import { DEFAULT_SETTINGS, type DedupeSettings } from '../shared/settings';

interface EventInfo {
	gid: string;
	titleKey: string;
	bodyKey: string;
	time: number;
}

interface Group {
	key: string;
	rep: EventInfo;
	repCard: HTMLElement;
	dupes: { info: EventInfo; card: HTMLElement }[];
}

const LOG = '[NewsDedupe]';
const CLAN_STEAMID_BASE = BigInt('103582791429521408');
const WATCHED_ENDPOINTS = /\/events\/(ajaxgetusereventcalendarrange|ajaxgeteventdetails|ajaxgetbatchedpartnerevent|ajaxgetadjacentpartnerevents|ajaxgetpartnereventsbyappid)/i;
const VIEW_LINK = /\/news\/(?:app\/\d+\/|group\/\d+\/)?view\/(\d{6,})/;
const DETAILS_BATCH = 20;
const NEAR_IN_TIME_SECONDS = 72 * 3600;
const MIN_TITLE_LEN_FOR_TIME_MATCH = 20;

const CLS_HIDDEN = 'nd-dupe-hidden';
const CLS_REVEALED = 'nd-dupe-revealed';
const CLS_BADGE = 'nd-dupe-badge';
const CLS_REP = 'nd-dupe-rep';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings: DedupeSettings = { ...DEFAULT_SETTINGS };
const gidToClan = new Map<string, string>();
const infoByGid = new Map<string, EventInfo>();
const requestedUrls = new Set<string>();
const detailsRequested = new Set<string>();
const cardCache = new WeakMap<HTMLAnchorElement, HTMLElement>();
const labelCache = new WeakMap<HTMLElement, string>();
const revealedGroups = new Set<string>();
let scanTimer: number | undefined;
let started = false;

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeTitle(s: string): string {
	return (s || '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[‘’‛′]/g, "'")
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function normalizeBody(s: string): string {
	return (s || '')
		.replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, ' ') // images
		.replace(/\{STEAM_CLAN_IMAGE\}\S*/g, ' ')
		.replace(/\[\/?[^\]]{1,64}\]/g, ' ') // remaining bbcode tags (keep inner text)
		.replace(/https?:\/\/\S+/g, ' ') // urls (often per-game store links)
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}]+/gu, '') // letters only
		.slice(0, 400);
}

function clanIdFromSteamId(steamId: unknown): string | undefined {
	try {
		if (steamId === undefined || steamId === null || steamId === '') return undefined;
		const n = BigInt(String(steamId)) - CLAN_STEAMID_BASE;
		return n > BigInt(0) ? n.toString() : undefined;
	} catch {
		return undefined;
	}
}

function absoluteUrl(u: string): string {
	try {
		return new URL(u, location.href).href;
	} catch {
		return u;
	}
}

// ---------------------------------------------------------------------------
// Ingesting event data
// ---------------------------------------------------------------------------

function ingestEvent(ev: any) {
	if (!ev || typeof ev !== 'object' || !ev.gid || typeof ev.event_name !== 'string') return;
	const gid = String(ev.gid);
	const clan = clanIdFromSteamId(ev.clan_steamid);
	if (clan) gidToClan.set(gid, clan);

	const body = ev.announcement_body?.body ?? ev.event_notes ?? '';
	infoByGid.set(gid, {
		gid,
		titleKey: normalizeTitle(ev.announcement_body?.headline || ev.event_name),
		bodyKey: normalizeBody(body),
		time: Number(ev.rtime32_start_time || ev.announcement_body?.posttime || 0),
	});
}

function ingestDocument(doc: any) {
	if (!doc || typeof doc !== 'object') return;
	const gid = doc.unique_id ?? doc.gid;
	if (gid && doc.clanid) gidToClan.set(String(gid), String(doc.clanid));
}

/** Walk any JSON payload from the events endpoints and pull out what we need. */
function ingestPayload(json: any) {
	if (!json || typeof json !== 'object') return;
	if (Array.isArray(json)) {
		json.forEach(ingestPayload);
		return;
	}
	if (Array.isArray(json.documents)) json.documents.forEach(ingestDocument);
	if (Array.isArray(json.events)) json.events.forEach(ingestEvent);
	if (json.event && typeof json.event === 'object') ingestEvent(json.event);
	if (json.gid && json.event_name) ingestEvent(json);
}

/** Data Steam embeds directly into the page HTML. */
function ingestEmbeddedConfig() {
	const cfg = document.getElementById('application_config');
	if (!cfg) return;
	for (const attr of ['initialevents', 'partnereventstore']) {
		const raw = cfg.dataset[attr];
		if (!raw) continue;
		try {
			ingestPayload(JSON.parse(raw));
		} catch {
			/* ignore */
		}
	}
}

async function fetchJson(url: string): Promise<any> {
	const res = await fetch(url, { credentials: 'include' });
	if (!res.ok) throw new Error(`${res.status} for ${url}`);
	return res.json();
}

/** Re-read a feed response the page itself requested. */
function onResourceUrl(rawUrl: string) {
	if (!WATCHED_ENDPOINTS.test(rawUrl)) return;
	const url = absoluteUrl(rawUrl);
	if (requestedUrls.has(url)) return;
	requestedUrls.add(url);
	fetchJson(url)
		.then((json) => {
			ingestPayload(json);
			scheduleScan();
		})
		.catch((e) => console.debug(LOG, 'could not read', url, e));
}

function watchNetwork() {
	try {
		// Default buffer is small; the hub can make lots of requests while scrolling.
		performance.setResourceTimingBufferSize?.(5000);
	} catch {
		/* ignore */
	}
	try {
		performance.getEntriesByType('resource').forEach((e) => onResourceUrl(e.name));
		const po = new PerformanceObserver((list) => list.getEntries().forEach((e) => onResourceUrl(e.name)));
		po.observe({ type: 'resource', buffered: true });
	} catch (e) {
		console.warn(LOG, 'PerformanceObserver unavailable', e);
	}
}

/** Fetch details for cards whose event info we don't have yet. */
function requestMissingDetails(gids: string[]) {
	const todo = gids.filter((g) => !infoByGid.has(g) && !detailsRequested.has(g) && gidToClan.has(g));
	for (let i = 0; i < todo.length; i += DETAILS_BATCH) {
		const batch = todo.slice(i, i + DETAILS_BATCH);
		batch.forEach((g) => detailsRequested.add(g));
		const params = new URLSearchParams({
			clanid_list: batch.map((g) => gidToClan.get(g)!).join(','),
			uniqueid_list: batch.join(','),
			lang_list: '0',
		});
		const url = absoluteUrl(`/events/ajaxgeteventdetails/?${params.toString()}`);
		requestedUrls.add(url);
		fetchJson(url)
			.then((json) => {
				ingestPayload(json);
				scheduleScan();
			})
			.catch((e) => console.debug(LOG, 'details lookup failed', e));
	}
}

// ---------------------------------------------------------------------------
// DOM handling
// ---------------------------------------------------------------------------

function gidFromHref(href: string): string | undefined {
	const m = VIEW_LINK.exec(href);
	return m ? m[1] : undefined;
}

/**
 * Climb from the link to the outermost element that still only describes
 * this one event (i.e. contains no links to *other* events), without
 * swallowing a whole section that happens to contain a single card.
 */
function findCard(anchor: HTMLAnchorElement, gid: string): HTMLElement {
	const cached = cardCache.get(anchor);
	if (cached && cached.isConnected && cached.contains(anchor)) return cached;

	let card: HTMLElement = anchor;
	for (let depth = 0; depth < 12; depth++) {
		const parent = card.parentElement;
		if (!parent || parent === document.body || parent === document.documentElement) break;

		let foreign = false;
		parent.querySelectorAll<HTMLAnchorElement>('a[href*="/view/"]').forEach((a) => {
			const g = gidFromHref(a.href);
			if (g && g !== gid) foreign = true;
		});
		if (foreign) break;

		const cardH = card.getBoundingClientRect().height;
		const parentH = parent.getBoundingClientRect().height;
		if (cardH > 0 && parentH > cardH * 1.5 + 60) break;

		card = parent;
	}
	cardCache.set(anchor, card);
	return card;
}

function isDuplicateOf(a: EventInfo, b: EventInfo): boolean {
	if (a.gid === b.gid || !a.titleKey || a.titleKey !== b.titleKey) return false;
	if (settings.titleOnly) return true;
	if (a.bodyKey && a.bodyKey === b.bodyKey) return true;
	return a.titleKey.length >= MIN_TITLE_LEN_FOR_TIME_MATCH && Math.abs(a.time - b.time) <= NEAR_IN_TIME_SECONDS;
}

/** First line of a card's text (usually the game name). Cached while the card is still visible. */
function cardLabel(card: HTMLElement): string {
	const cached = labelCache.get(card);
	if (cached) return cached;
	if (card.classList.contains(CLS_HIDDEN)) return 'another game';
	const NOISE = /^(watch youtube video|watch video|featured|news|live now|play|\d+)$/i;
	const first = (card.innerText || '')
		.split('\n')
		.map((s) => s.trim())
		.find((s) => s.length > 1 && !NOISE.test(s));
	const label = first ? first.slice(0, 80) : 'another game';
	labelCache.set(card, label);
	return label;
}

/** Links inside the post viewer popup are not feed cards. */
function isInsideModal(el: Element): boolean {
	return !!el.closest('.FullModalOverlay, .ModalOverlayContent, [role="dialog"]');
}

/** The post the user has open right now (popup or direct link) is never hidden. */
function currentlyOpenGid(): string | undefined {
	try {
		const emgid = new URLSearchParams(location.search).get('emgid');
		if (emgid) return emgid;
	} catch {
		/* ignore */
	}
	return gidFromHref(location.pathname);
}

function setClass(el: HTMLElement, cls: string, on: boolean) {
	if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

function removeBadge(card: HTMLElement) {
	card.querySelectorAll(`:scope > .${CLS_BADGE}`).forEach((b) => b.remove());
	setClass(card, CLS_REP, false);
}

function upsertBadge(group: Group) {
	const card = group.repCard;
	const revealed = revealedGroups.has(group.key);
	const n = group.dupes.length;
	const text = revealed ? `Hide ${n} duplicate${n === 1 ? '' : 's'}` : `+${n} duplicate${n === 1 ? '' : 's'}`;
	const tip = `Same post also published for:\n${group.dupes.map((d) => '• ' + cardLabel(d.card)).join('\n')}\n\nClick to ${revealed ? 'hide' : 'show'} them.`;

	let badge = card.querySelector<HTMLElement>(`:scope > .${CLS_BADGE}`);
	if (!badge) {
		badge = document.createElement('div');
		badge.className = CLS_BADGE;
		badge.setAttribute('role', 'button');
		badge.tabIndex = 0;
		const toggle = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			const key = badge!.dataset.groupKey!;
			if (revealedGroups.has(key)) revealedGroups.delete(key);
			else revealedGroups.add(key);
			scan();
		};
		badge.addEventListener('click', toggle, true);
		badge.addEventListener('mousedown', (e) => e.stopPropagation(), true);
		badge.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') toggle(e);
		});
		card.appendChild(badge);
	}
	setClass(card, CLS_REP, true);
	if (badge.dataset.groupKey !== group.key) badge.dataset.groupKey = group.key;
	if (badge.textContent !== text) badge.textContent = text;
	if (badge.title !== tip) badge.title = tip;
}

function clearAll() {
	document.querySelectorAll<HTMLElement>(`.${CLS_HIDDEN}, .${CLS_REVEALED}`).forEach((el) => {
		el.classList.remove(CLS_HIDDEN, CLS_REVEALED);
	});
	document.querySelectorAll<HTMLElement>(`.${CLS_REP}`).forEach(removeBadge);
}

export function scan() {
	if (!settings.enabled) {
		clearAll();
		return;
	}

	const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/view/"]'));
	const groups: Group[] = [];
	const seenCards = new Set<HTMLElement>();
	const hide = new Set<HTMLElement>();
	const reveal = new Set<HTMLElement>();
	const reps = new Set<HTMLElement>();
	const missing: string[] = [];
	const openGid = currentlyOpenGid();

	for (const a of anchors) {
		const gid = gidFromHref(a.href);
		if (!gid || isInsideModal(a)) continue;
		const card = findCard(a, gid);
		if (seenCards.has(card)) continue;
		seenCards.add(card);
		cardLabel(card); // remember the label while the card is still visible

		const info = infoByGid.get(gid);
		if (!info) {
			missing.push(gid);
			continue;
		}

		const group = groups.find((g) => isDuplicateOf(g.rep, info));
		if (!group || gid === openGid) {
			groups.push({ key: `${info.titleKey}#${info.gid}`, rep: info, repCard: card, dupes: [] });
			continue;
		}
		group.dupes.push({ info, card });
		(revealedGroups.has(group.key) ? reveal : hide).add(card);
	}

	for (const g of groups) {
		if (g.dupes.length && settings.showBadge) {
			upsertBadge(g);
			reps.add(g.repCard);
		}
	}

	// Apply (idempotently, so our own DOM changes settle immediately).
	document.querySelectorAll<HTMLElement>(`.${CLS_HIDDEN}`).forEach((el) => !hide.has(el) && el.classList.remove(CLS_HIDDEN));
	document.querySelectorAll<HTMLElement>(`.${CLS_REVEALED}`).forEach((el) => !reveal.has(el) && el.classList.remove(CLS_REVEALED));
	document.querySelectorAll<HTMLElement>(`.${CLS_REP}`).forEach((el) => !reps.has(el) && removeBadge(el));
	hide.forEach((el) => setClass(el, CLS_HIDDEN, true));
	reveal.forEach((el) => setClass(el, CLS_REVEALED, true));

	if (missing.length) requestMissingDetails(missing);
}

export function scheduleScan(delay = 150) {
	if (scanTimer !== undefined) return;
	scanTimer = window.setTimeout(() => {
		scanTimer = undefined;
		try {
			scan();
		} catch (e) {
			console.error(LOG, 'scan failed', e);
		}
	}, delay);
}

function injectStyles() {
	if (document.getElementById('nd-dupe-styles')) return;
	const style = document.createElement('style');
	style.id = 'nd-dupe-styles';
	style.textContent = `
		.${CLS_HIDDEN} { display: none !important; }
		.${CLS_REVEALED} { opacity: .5; outline: 1px dashed rgba(255,255,255,.3); outline-offset: -1px; }
		.${CLS_REP} { position: relative; }
		.${CLS_BADGE} {
			position: absolute; top: 6px; right: 6px; z-index: 5;
			padding: 2px 8px; border-radius: 10px;
			font: 600 11px/16px "Motiva Sans", Arial, sans-serif; letter-spacing: .02em;
			color: #dcdedf; background: rgba(23, 26, 33, .88);
			border: 1px solid rgba(103, 193, 245, .5);
			cursor: pointer; user-select: none; white-space: nowrap;
		}
		.${CLS_BADGE}:hover { color: #fff; background: rgba(103, 193, 245, .35); }
	`;
	(document.head || document.documentElement).appendChild(style);
}

export function updateSettings(next: Partial<DedupeSettings>) {
	settings = { ...settings, ...next };
	if (started) {
		clearAll();
		scan();
	}
}

export function start(initial?: Partial<DedupeSettings>) {
	if (started) return;
	started = true;
	if (initial) settings = { ...settings, ...initial };

	const boot = () => {
		injectStyles();
		ingestEmbeddedConfig();
		watchNetwork();
		new MutationObserver(() => scheduleScan()).observe(document.body, { childList: true, subtree: true });
		scheduleScan(0);
		console.log(LOG, 'active on', location.pathname, settings);
	};

	if (document.body) boot();
	else document.addEventListener('DOMContentLoaded', boot, { once: true });
}

/** Exposed for debugging from the devtools console: window.__newsDedupe */
export const debug = { infoByGid, gidToClan, get settings() { return settings; }, scan };
