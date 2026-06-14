#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_LOG_PATH =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\client.txt";

const RELEASE_WINDOWS = [
  ["0.4", "The Last of the Druids", "2025-12-12T19:00:00Z"],
  ["0.3", "The Third Edict", "2025-08-29T19:00:00Z"],
  ["0.2", "Dawn of the Hunt", "2025-04-04T19:00:00Z"],
  ["0.1", "Early Access", "2024-12-06T19:00:00Z"],
];

const ASCENDANCY_TO_BASE = new Map(
  Object.entries({
    amazon: "Huntress",
    ritualist: "Huntress",
    deadeye: "Ranger",
    pathfinder: "Ranger",
    titan: "Warrior",
    warbringer: "Warrior",
    "smith of kitava": "Warrior",
    witchhunter: "Mercenary",
    "gemling legionnaire": "Mercenary",
    tactician: "Mercenary",
    stormweaver: "Sorceress",
    chronomancer: "Sorceress",
    infernalist: "Witch",
    "blood mage": "Witch",
    lich: "Witch",
    invoker: "Monk",
    "acolyte of chayula": "Monk",
    "disciple of varashta": "Monk",
    shaman: "Druid",
    oracle: "Druid",
  }),
);

const BASE_CLASSES = new Set([
  "Huntress",
  "Ranger",
  "Warrior",
  "Mercenary",
  "Sorceress",
  "Witch",
  "Monk",
  "Druid",
]);

const LOG_PREFIX =
  /^(?<date>\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\s+(?<ms>\d+)\s+\S+\s+\[(?<level>\w+) Client (?<pid>\d+)\]\s+(?<message>.*)$/;
const LOG_OPENING = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \*{5} LOG FILE OPENING/;
const USER_AGENT = /User agent: PoE poe2_production\/tags\/(?<tag>\S+)/;
const AREA = /Generating level (?<level>\d+) area "(?<area>[^"]+)" with seed (?<seed>\d+)/;
const SCENE = /\[SCENE\] Set Source \[(?<scene>.+?)\]/;
const LEVEL_UP = /: (?<character>.+?) \((?<className>[^)]+)\) is now level (?<level>\d+)/;
const PASSIVE =
  /Successfully (?<action>unallocated|allocated) passive skill id: (?<id>[^,]+), name: (?<name>.+)/;
const TRADE_LEAGUE_PATTERNS = [
  /\blisted for\b.*?\bin\s+(?<league>[^()]+?)\s+\(stash tab/i,
  /\blisted by\b.*?\bin\s+(?<league>[^()]+?)\s+\(stash tab/i,
  /\blistado por\b.*?\b(?:na|no|em)\s+(?<league>[^()]+?)\s+\(aba/i,
  /\bcomprar\b.*?\ben\s+(?<league>[^()]+?)\s+\(/i,
  /標價.*?\s在\s(?<league>[^()]+?)\s\(/i,
  /(?<league>Standard|Hardcore)\s+리그/i,
  /\b(?<league>Standard|Hardcore)\b.*?(?:stash tab|倉庫頁|보관함|aba|sección|секция|ลีก)/i,
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function parseDate(value) {
  const [date, time] = value.split(" ");
  const [year, month, day] = date.split("/").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

function secondsBetween(start, end) {
  return Math.max(0, (end.getTime() - start.getTime()) / 1000);
}

function inferEaFromTag(tag) {
  const match = /^4\.(\d+)\./.exec(tag || "");
  if (!match) return null;
  const minor = Number(match[1]);
  return minor >= 1 && minor <= 9 ? `0.${minor}` : null;
}

function inferEaFromDate(date) {
  for (const [version, , startedAt] of RELEASE_WINDOWS) {
    if (date >= new Date(startedAt)) return version;
  }
  return null;
}

function normalizeClass(className) {
  if (!className) return null;
  if (BASE_CLASSES.has(className)) return className;
  return ASCENDANCY_TO_BASE.get(className.toLowerCase()) || className;
}

function categorizeArea(area) {
  if (area.includes("Hideout")) return ["Hideout", "Hideout"];
  const act = /^G(\d+)_/.exec(area);
  if (act) return [`Act ${Number(act[1])}`, "Campaign"];
  if (area.toLowerCase().includes("town")) return ["Town", "Town"];
  if (area.toLowerCase().startsWith("map") || area.toLowerCase().includes("atlas")) {
    return ["Endgame", "Endgame"];
  }
  return ["Other", "Other"];
}

function cleanLeagueName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[;,.]+$/g, "")
    .trim();
}

function leagueType(name) {
  const lower = String(name || "").toLowerCase();
  if (!name) return "Unknown";
  if (lower.includes("hcssf") || (lower.includes("hardcore") && lower.includes("ssf"))) {
    return "Hardcore SSF";
  }
  if (lower.includes("solo self") || /\bssf\b/i.test(name)) return "SSF";
  if (lower.includes("hardcore")) return "Hardcore";
  if (lower === "standard") return "Standard";
  if (lower.includes("race") || lower.includes("event")) return "Private/Event";
  return "Private/Custom";
}

function tradeLeagueHint(message) {
  if (!/^@(?:To|From)\b/i.test(message)) return null;
  if (!/(stash tab|倉庫頁|보관함|aba|sección|секция|ลีก|リ\u30fcグ)/i.test(message)) return null;
  for (const pattern of TRADE_LEAGUE_PATTERNS) {
    const match = pattern.exec(message);
    const league = cleanLeagueName(match?.groups?.league);
    if (league) return league;
  }
  return null;
}

function slug(value) {
  return String(value || "indefinida")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "indefinida";
}

function isEndgameMapArea(area) {
  return /^Map/i.test(area || "");
}

function cleanSceneSource(source) {
  const value = String(source || "").trim();
  if (!value || value === "(null)" || value === "(unknown)" || value === "Atlas") return null;
  if (/hideout/i.test(value) || /\btown\b/i.test(value) || /^Act \d+/i.test(value)) return null;
  return value;
}

function displayMapName(area) {
  const name = String(area || "")
    .replace(/^Map/i, "")
    .replace(/^UberBoss_/i, "")
    .replace(/_NoBoss$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return name || area || "Endgame map";
}

function addCount(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

function topObject(object, limit = null) {
  const entries = Object.entries(object).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(limit ? entries.slice(0, limit) : entries);
}

function mergeWindows(windows) {
  if (!windows.length) return [];
  const sorted = windows.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function windowSeconds(windows) {
  return mergeWindows(windows).reduce((sum, [start, end]) => sum + secondsBetween(start, end), 0);
}

async function parseLog(logPath) {
  const events = [];
  const clientTags = {};
  let lineCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineCount += 1;

    const opening = LOG_OPENING.exec(line);
    if (opening) {
      const ts = parseDate(opening[1]);
      events.push({ ts, kind: "session_start", data: {} });
      firstTimestamp ||= ts;
      lastTimestamp = ts;
      continue;
    }

    const parsed = LOG_PREFIX.exec(line);
    if (!parsed) continue;
    const ts = parseDate(parsed.groups.date);
    const message = parsed.groups.message;
    firstTimestamp ||= ts;
    lastTimestamp = ts;

    const userAgent = USER_AGENT.exec(message);
    if (userAgent) {
      const tag = userAgent.groups.tag;
      addCount(clientTags, tag);
      events.push({ ts, kind: "user_agent", data: { tag, eaVersion: inferEaFromTag(tag) } });
      continue;
    }

    const area = AREA.exec(message);
    if (area) {
      const [act, category] = categorizeArea(area.groups.area);
      events.push({
        ts,
        kind: "area",
        data: {
          level: Number(area.groups.level),
          area: area.groups.area,
          seed: area.groups.seed,
          act,
          category,
        },
      });
      continue;
    }

    const scene = SCENE.exec(message);
    if (scene && scene.groups.scene !== "(null)") {
      events.push({ ts, kind: "scene", data: { source: scene.groups.scene } });
      continue;
    }

    const level = LEVEL_UP.exec(message);
    if (level) {
      events.push({
        ts,
        kind: "level_up",
        data: {
          character: level.groups.character.trim(),
          class: level.groups.className,
          baseClass: normalizeClass(level.groups.className),
          level: Number(level.groups.level),
        },
      });
      continue;
    }

    const passive = PASSIVE.exec(message);
    if (passive) {
      events.push({
        ts,
        kind: "passive",
        data: {
          action: passive.groups.action,
          id: passive.groups.id,
          name: passive.groups.name.trim(),
        },
      });
      continue;
    }

    const leagueHint = tradeLeagueHint(message);
    if (leagueHint) {
      events.push({
        ts,
        kind: "league_hint",
        data: {
          league: leagueHint,
          type: leagueType(leagueHint),
          source: "trade_whisper",
        },
      });
      continue;
    }

    if (message.includes("[WINDOW] Lost focus")) events.push({ ts, kind: "focus_lost", data: {} });
    else if (message.includes("[WINDOW] Gained focus")) events.push({ ts, kind: "focus_gained", data: {} });
    else if (message.includes("AFK mode is now ON") || message.includes("Modo LDT Ativado")) {
      events.push({ ts, kind: "afk_on", data: {} });
    } else if (message.includes("AFK mode is now OFF") || message.includes("Modo LDT Desativado")) {
      events.push({ ts, kind: "afk_off", data: {} });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return {
    events,
    metadata: {
      sourcePath: logPath,
      fileSize: fs.statSync(logPath).size,
      lineCount,
      firstTimestamp: firstTimestamp?.toISOString() || null,
      lastTimestamp: lastTimestamp?.toISOString() || null,
      clientTags: topObject(clientTags),
    },
  };
}

function buildCampaigns(events, cooldownMinutes = 25) {
  const campaigns = [];
  let lastStart = null;

  for (const event of events) {
    if (event.kind !== "area") continue;
    if (event.data.area !== "G1_1" || event.data.level !== 1) continue;
    if (lastStart && secondsBetween(lastStart, event.ts) < cooldownMinutes * 60) continue;
    if (campaigns.length) campaigns[campaigns.length - 1].end = event.ts;
    campaigns.push({ index: campaigns.length + 1, start: event.ts, end: null, events: [] });
    lastStart = event.ts;
  }

  if (!campaigns.length) {
    if (!events.length) return [];
    return [{ index: 1, start: events[0].ts, end: events[events.length - 1].ts, events }];
  }

  const finalTs = events[events.length - 1]?.ts || null;
  for (const campaign of campaigns) campaign.end ||= finalTs;

  let campaignIndex = 0;
  for (const event of events) {
    while (
      campaignIndex + 1 < campaigns.length &&
      campaigns[campaignIndex + 1].start <= event.ts
    ) {
      campaignIndex += 1;
    }
    const campaign = campaigns[campaignIndex];
    if (campaign.start <= event.ts && event.ts < campaign.end) campaign.events.push(event);
  }

  return campaigns;
}

function summarizeIntervals(events, start, end) {
  const areas = events.filter((event) => event.kind === "area");
  const actSeconds = {};
  const areaSeconds = {};
  const categorySeconds = {};
  let inactiveGapSeconds = 0;
  const cap = 60 * 60;

  areas.forEach((event, index) => {
    const next = areas[index + 1]?.ts || end;
    let delta = secondsBetween(event.ts, next);
    if (delta > cap) {
      inactiveGapSeconds += delta - cap;
      delta = cap;
    }
    addCount(actSeconds, event.data.act, delta);
    addCount(areaSeconds, event.data.area, delta);
    addCount(categorySeconds, event.data.category, delta);
  });

  return {
    actSeconds: topObject(actSeconds),
    areaSecondsTop: topObject(areaSeconds, 20),
    categorySeconds: topObject(categorySeconds),
    activeSeconds: Object.values(categorySeconds).reduce((sum, value) => sum + value, 0),
    inactiveGapSeconds,
    areaCount: areas.length,
  };
}

function sceneNameNearArea(areaEvent, nextAreaTs, scenes) {
  const upperBound = Math.min(
    nextAreaTs?.getTime() || Infinity,
    areaEvent.ts.getTime() + 15_000,
  );
  for (const scene of scenes) {
    if (scene.ts < areaEvent.ts) continue;
    if (scene.ts.getTime() > upperBound) break;
    const name = cleanSceneSource(scene.data.source);
    if (name) return name;
  }
  return null;
}

function summarizeEndgameMaps(events) {
  const areas = events.filter((event) => event.kind === "area");
  const scenes = events.filter((event) => event.kind === "scene");
  const instances = new Map();
  const orderedInstances = [];
  let entryCount = 0;

  areas.forEach((event, index) => {
    if (!isEndgameMapArea(event.data.area)) return;
    entryCount += 1;
    const key = `${event.data.area}|${event.data.seed}`;
    let instance = instances.get(key);
    if (!instance) {
      instance = {
        area: event.data.area,
        seed: event.data.seed,
        name: displayMapName(event.data.area),
        level: event.data.level,
        entries: 0,
        firstSeen: event.ts,
        lastSeen: event.ts,
      };
      instances.set(key, instance);
      orderedInstances.push(instance);
    }
    instance.entries += 1;
    instance.lastSeen = event.ts;
    instance.level = Math.max(instance.level, event.data.level);

    const sceneName = sceneNameNearArea(event, areas[index + 1]?.ts, scenes);
    if (sceneName) instance.name = sceneName;
  });

  const mapCounts = {};
  const mapEntryCounts = {};
  const internalAreaCounts = {};
  for (const instance of orderedInstances) {
    addCount(mapCounts, instance.name);
    addCount(mapEntryCounts, instance.name, instance.entries);
    addCount(internalAreaCounts, instance.area);
  }

  return {
    endgameMapCount: orderedInstances.length,
    endgameMapEntryCount: entryCount,
    endgameMapCounts: topObject(mapCounts),
    endgameMapEntryCounts: topObject(mapEntryCounts),
    internalAreaCounts: topObject(internalAreaCounts),
    recentEndgameMaps: orderedInstances.slice(-12).map((instance) => ({
      name: instance.name,
      area: instance.area,
      seed: instance.seed,
      level: instance.level,
      entries: instance.entries,
      firstSeen: instance.firstSeen.toISOString(),
      lastSeen: instance.lastSeen.toISOString(),
    })),
  };
}

function summarizeStateWindows(events, start, end) {
  const afkWindows = [];
  const focusWindows = [];
  const passiveWindows = [];
  let afkStart = null;
  let focusStart = null;

  for (const event of events) {
    if (event.kind === "afk_on") afkStart = event.ts;
    else if (event.kind === "afk_off" && afkStart) {
      afkWindows.push([afkStart, event.ts]);
      afkStart = null;
    } else if (event.kind === "focus_lost") focusStart = event.ts;
    else if (event.kind === "focus_gained" && focusStart) {
      focusWindows.push([focusStart, event.ts]);
      focusStart = null;
    } else if (event.kind === "passive") {
      passiveWindows.push([
        new Date(Math.max(start.getTime(), event.ts.getTime() - 45_000)),
        new Date(Math.min(end.getTime(), event.ts.getTime() + 75_000)),
      ]);
    }
  }

  if (afkStart) afkWindows.push([afkStart, end]);
  if (focusStart) focusWindows.push([focusStart, end]);

  return {
    afkSeconds: windowSeconds(afkWindows),
    focusLostSeconds: windowSeconds(focusWindows),
    passiveTreeSecondsEstimated: windowSeconds(passiveWindows),
    afkWindows: mergeWindows(afkWindows)
      .slice(0, 20)
      .map(([a, b]) => [a.toISOString(), b.toISOString()]),
    focusLostWindows: mergeWindows(focusWindows)
      .slice(0, 20)
      .map(([a, b]) => [a.toISOString(), b.toISOString()]),
  };
}

function summarizeCharacters(events) {
  const rows = new Map();

  for (const event of events) {
    if (event.kind !== "level_up") continue;
    const character = event.data.character;
    if (!rows.has(character)) {
      rows.set(character, {
        character,
        levelUps: 0,
        minLevel: null,
        maxLevel: null,
        classes: {},
        baseClasses: {},
        firstSeen: null,
        lastSeen: null,
      });
    }
    const row = rows.get(character);
    row.levelUps += 1;
    row.minLevel = row.minLevel === null ? event.data.level : Math.min(row.minLevel, event.data.level);
    row.maxLevel = row.maxLevel === null ? event.data.level : Math.max(row.maxLevel, event.data.level);
    addCount(row.classes, event.data.class);
    if (event.data.baseClass) addCount(row.baseClasses, event.data.baseClass);
    row.firstSeen ||= event.ts;
    row.lastSeen = event.ts;
  }

  const characters = Array.from(rows.values())
    .map((row) => ({
      character: row.character,
      levelUps: row.levelUps,
      minLevel: row.minLevel,
      maxLevel: row.maxLevel,
      class: Object.keys(topObject(row.classes))[0] || null,
      baseClass: Object.keys(topObject(row.baseClasses))[0] || null,
      classes: topObject(row.classes),
      firstSeen: row.firstSeen?.toISOString() || null,
      lastSeen: row.lastSeen?.toISOString() || null,
    }))
    .sort((a, b) => b.levelUps - a.levelUps || (b.maxLevel || 0) - (a.maxLevel || 0));

  return { primary: characters[0] || null, characters: characters.slice(0, 10) };
}

function summarizePassives(events) {
  const passiveCounts = {};
  let allocated = 0;
  let unallocated = 0;

  for (const event of events) {
    if (event.kind !== "passive") continue;
    if (event.data.action === "allocated") {
      allocated += 1;
      addCount(passiveCounts, `${event.data.id} | ${event.data.name}`);
    } else {
      unallocated += 1;
    }
  }

  return {
    allocatedCount: allocated,
    unallocatedCount: unallocated,
    topPassives: topObject(passiveCounts, 15),
  };
}

function summarizeVersions(events, start) {
  const tags = {};
  const versions = {};
  for (const event of events) {
    if (event.kind !== "user_agent") continue;
    addCount(tags, event.data.tag);
    if (event.data.eaVersion) addCount(versions, event.data.eaVersion);
  }
  const eaVersion = Object.keys(topObject(versions))[0] || inferEaFromDate(start);
  return {
    eaVersion,
    clientTags: topObject(tags),
    versionSource: Object.keys(versions).length ? "client_tag" : "date_window",
  };
}

function summarizeLeagues(events) {
  const tradeHints = {};
  for (const event of events) {
    if (event.kind !== "league_hint") continue;
    addCount(tradeHints, event.data.league);
  }

  const entries = Object.entries(topObject(tradeHints));
  if (!entries.length) return [{ name: "Indefinida", type: "Unknown", source: "not_found", hints: {} }];
  return entries.map(([name, count]) => ({
    name,
    type: leagueType(name),
    source: "trade_whisper",
    tradeWhisperCount: count,
    hints: topObject(tradeHints, 8),
  }));
}

function aggregateEndgameMaps(campaigns) {
  const seen = new Set();
  const mapCounts = {};
  const mapEntryCounts = {};
  let endgameMapCount = 0;
  let endgameMapEntryCount = 0;

  for (const campaign of campaigns) {
    if (seen.has(campaign.sourceCampaignId)) continue;
    seen.add(campaign.sourceCampaignId);
    const maps = campaign.maps || {};
    endgameMapCount += maps.endgameMapCount || 0;
    endgameMapEntryCount += maps.endgameMapEntryCount || 0;
    for (const [name, count] of Object.entries(maps.endgameMapCounts || {})) {
      addCount(mapCounts, name, count);
    }
    for (const [name, count] of Object.entries(maps.endgameMapEntryCounts || {})) {
      addCount(mapEntryCounts, name, count);
    }
  }

  return {
    endgameMapCount,
    endgameMapEntryCount,
    endgameMapCounts: topObject(mapCounts),
    endgameMapEntryCounts: topObject(mapEntryCounts),
  };
}

function campaignToRows(campaign) {
  const characterSummary = summarizeCharacters(campaign.events);
  const passiveSummary = summarizePassives(campaign.events);
  const intervals = summarizeIntervals(campaign.events, campaign.start, campaign.end);
  const maps = summarizeEndgameMaps(campaign.events);
  const states = summarizeStateWindows(campaign.events, campaign.start, campaign.end);
  const version = summarizeVersions(campaign.events, campaign.start);
  const leagues = summarizeLeagues(campaign.events);
  const primary = characterSummary.primary;
  const baseId = `campaign_${String(campaign.index).padStart(3, "0")}`;

  const base = {
    id: baseId,
    sourceCampaignId: baseId,
    index: campaign.index,
    start: campaign.start.toISOString(),
    end: campaign.end.toISOString(),
    wallSeconds: secondsBetween(campaign.start, campaign.end),
    activeSeconds: intervals.activeSeconds,
    signalCount: campaign.events.length,
    version,
    character: primary,
    characters: characterSummary.characters,
    passives: passiveSummary,
    maps,
    timing: {
      ...intervals,
      ...states,
      endgameSeconds: intervals.categorySeconds.Endgame || 0,
      hideoutSeconds: intervals.categorySeconds.Hideout || 0,
      townSeconds: intervals.categorySeconds.Town || 0,
      campaignAreaSeconds: intervals.categorySeconds.Campaign || 0,
    },
  };

  return leagues.map((league, index) => ({
    ...base,
    id: leagues.length > 1 ? `${baseId}__${slug(league.name)}` : baseId,
    duplicateReason: leagues.length > 1 ? "multiple_trade_whisper_leagues" : null,
    league,
    leagueVariantIndex: index + 1,
  }));
}

async function makeAnalysis(logPath) {
  const { events, metadata } = await parseLog(logPath);
  const sourceCampaigns = buildCampaigns(events);
  const campaigns = sourceCampaigns.flatMap(campaignToRows);
  const endgameMaps = aggregateEndgameMaps(campaigns);
  const versionCounts = {};
  const baseClassCounts = {};
  const leagueCounts = {};
  let totalWallSeconds = 0;

  for (const campaign of campaigns) {
    totalWallSeconds += campaign.wallSeconds;
    addCount(versionCounts, campaign.version.eaVersion || "unknown");
    addCount(baseClassCounts, campaign.character?.baseClass || "unknown");
    addCount(leagueCounts, campaign.league?.name || "Indefinida");
  }

  return {
    generatedAt: new Date().toISOString(),
    metadata,
    summary: {
      campaignCount: campaigns.length,
      sourceCampaignCount: sourceCampaigns.length,
      duplicatedCampaignCount: campaigns.length - sourceCampaigns.length,
      totalWallSeconds,
      endgameMapCount: endgameMaps.endgameMapCount,
      endgameMapEntryCount: endgameMaps.endgameMapEntryCount,
      endgameMapCounts: endgameMaps.endgameMapCounts,
      endgameMapEntryCounts: endgameMaps.endgameMapEntryCounts,
      versionCounts: topObject(versionCounts),
      baseClassCounts: topObject(baseClassCounts),
      leagueCounts: topObject(leagueCounts),
    },
    campaigns,
    notes: [
      "Classe vem de level-up e pode incluir membros da party.",
      "Liga vem apenas de trade whispers; nomes de personagem nao sao usados para inferir liga.",
      "Campanhas podem ser duplicadas quando trade whispers apontam multiplas ligas.",
      "Mapas endgame contam areas internas Map* deduplicadas por seed; reentradas ficam separadas.",
      "Passive tree e estimado ao redor de alocacoes/desalocacoes.",
      "Pause nao aparece diretamente no client.txt; foco perdido e AFK ficam separados.",
    ],
  };
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll("</script>", "<\\/script>");
}

function dashboardHtml(analysis) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoE2 Client Analytics</title>
<style>
:root{--bg:#101214;--panel:#181d20;--panel2:#20272b;--text:#eef1ee;--muted:#aeb7b1;--line:#333c41;--accent:#e2b75a;--good:#73c18f;--cold:#73a8d7;--warn:#d98966}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",sans-serif}header{padding:22px 28px 14px;background:#15181a;border-bottom:1px solid var(--line)}h1{margin:0;font-size:24px;letter-spacing:0}.sub,.muted{color:var(--muted)}.sub{font-size:13px;margin-top:6px}main{padding:20px 28px 34px}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 150px 150px 170px;gap:10px;margin-bottom:16px}input,select{width:100%;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font-size:14px}.fileFacts,.metrics{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px;margin-bottom:18px}.fileFacts{grid-template-columns:repeat(6,minmax(120px,1fr))}.metric,.card{background:var(--panel);border:1px solid var(--line);border-radius:8px}.metric{padding:14px;min-height:84px}.label{color:var(--muted);font-size:12px;text-transform:uppercase}.value{font-size:24px;font-weight:700;margin-top:6px}.grid{display:grid;grid-template-columns:380px minmax(0,1fr);gap:14px;align-items:start}.list{display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 245px);overflow:auto;padding-right:4px}.run{text-align:left;width:100%;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:12px;cursor:pointer}.run.active{border-color:var(--accent);background:var(--panel2)}.runTop{display:flex;justify-content:space-between;gap:10px}.runTitle{font-weight:700;overflow-wrap:anywhere}.pill{display:inline-flex;align-items:center;min-height:24px;padding:2px 8px;border-radius:999px;background:#2a3034;color:var(--muted);font-size:12px;white-space:nowrap}.detail{padding:16px}.detail h2{margin:0 0 4px;font-size:22px}.detailRow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.small{background:#15191b;border:1px solid var(--line);border-radius:6px;padding:10px;min-height:72px}.split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.bars{display:grid;gap:8px;margin-top:10px}.barRow{display:grid;grid-template-columns:125px minmax(0,1fr) 70px;gap:10px;align-items:center}.barLabel{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.barTrack{height:12px;background:#101315;border-radius:999px;overflow:hidden}.barFill{height:100%;background:var(--accent);min-width:2px}.barValue{color:var(--muted);font-size:12px;text-align:right}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left}th{color:var(--muted);font-weight:600}@media(max-width:980px){.toolbar,.fileFacts,.metrics,.grid,.detailRow,.split{grid-template-columns:1fr}.list{max-height:none}main,header{padding-left:16px;padding-right:16px}}
</style>
</head>
<body>
<header><h1>PoE2 Client Analytics</h1><div class="sub" id="source"></div></header>
<main>
<div class="toolbar"><input id="search" placeholder="Filtrar personagem, classe, versao ou liga"><select id="versionFilter"></select><select id="classFilter"></select><select id="leagueFilter"></select></div>
<section class="fileFacts" id="fileFacts"></section>
<section class="metrics" id="metrics"></section>
<section class="grid"><div class="list" id="campaignList"></div><div class="card detail" id="detail"></div></section>
</main>
<script id="analysis-json" type="application/json">${escapeScriptJson(analysis)}</script>
<script>
const analysis=JSON.parse(document.getElementById('analysis-json').textContent),campaigns=analysis.campaigns||[];let selectedId=campaigns[0]?.id||null;
const fmtDate=v=>v?new Date(v).toLocaleString('pt-BR'):'-',fmtDuration=s=>{s=Math.max(0,Math.round(s||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;if(h)return h+'h '+String(m).padStart(2,'0')+'m';if(m)return m+'m '+String(sec).padStart(2,'0')+'s';return sec+'s'};
const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function uniqueSourceRows(rows){const seen=new Map();for(const row of rows){const key=row.sourceCampaignId||row.id;if(!seen.has(key))seen.set(key,row)}return Array.from(seen.values())}
function fillFilters(){const uniq=a=>[...new Set(a.filter(Boolean))].sort();versionFilter.innerHTML='<option value="">Versao: todas</option>'+uniq(campaigns.map(c=>c.version?.eaVersion||'unknown')).map(v=>'<option>'+esc(v)+'</option>').join('');classFilter.innerHTML='<option value="">Classe: todas</option>'+uniq(campaigns.map(c=>c.character?.baseClass||'unknown')).map(v=>'<option>'+esc(v)+'</option>').join('');leagueFilter.innerHTML='<option value="">Liga: todas</option>'+uniq(campaigns.map(c=>c.league?.name||'Indefinida')).map(v=>'<option>'+esc(v)+'</option>').join('')}
function filtered(){const q=search.value.trim().toLowerCase(),vf=versionFilter.value,cf=classFilter.value,lf=leagueFilter.value;return campaigns.filter(c=>{const text=[c.id,c.sourceCampaignId,c.version?.eaVersion,c.league?.name,c.league?.type,c.character?.character,c.character?.baseClass,c.character?.class,Object.keys(c.maps?.endgameMapCounts||{}).join(' ')].join(' ').toLowerCase();if(q&&!text.includes(q))return false;if(vf&&(c.version?.eaVersion||'unknown')!==vf)return false;if(cf&&(c.character?.baseClass||'unknown')!==cf)return false;if(lf&&(c.league?.name||'Indefinida')!==lf)return false;return true})}
function metric(label,value){return '<div class="metric"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'}
function renderFileFacts(){fileFacts.innerHTML=[metric('Tamanho',analysis.metadata.fileSize?((analysis.metadata.fileSize/1024/1024).toFixed(1)+' MB'):'-'),metric('Analisado em',fmtDate(analysis.generatedAt)),metric('Ligas detectadas',Object.keys(analysis.summary.leagueCounts||{}).filter(n=>n!=='Indefinida').length),metric('Linhas',(analysis.metadata.lineCount||0).toLocaleString('pt-BR')),metric('Inicio logs',fmtDate(analysis.metadata.firstTimestamp)),metric('Fim logs',fmtDate(analysis.metadata.lastTimestamp))].join('')}
function renderMetrics(rows){const unique=uniqueSourceRows(rows),total=unique.reduce((s,c)=>s+((c.activeSeconds??c.wallSeconds)||0),0),hideout=unique.reduce((s,c)=>s+(c.timing?.hideoutSeconds||0),0),afk=unique.reduce((s,c)=>s+(c.timing?.afkSeconds||0),0),passive=unique.reduce((s,c)=>s+(c.timing?.passiveTreeSecondsEstimated||0),0),endgame=unique.reduce((s,c)=>s+(c.timing?.endgameSeconds||0),0),maps=unique.reduce((s,c)=>s+(c.maps?.endgameMapCount||0),0),entries=unique.reduce((s,c)=>s+(c.maps?.endgameMapEntryCount||0),0);metrics.innerHTML=[metric('Campanhas',rows.length),metric('Mapas endgame',maps),metric('Entradas mapa',entries),metric('Tempo endgame',fmtDuration(endgame)),metric('Tempo ativo',fmtDuration(total)),metric('Hideout',fmtDuration(hideout)),metric('AFK',fmtDuration(afk)),metric('Passive tree',fmtDuration(passive)),metric('Duplicadas',rows.filter(c=>c.duplicateReason).length)].join('')}
function renderList(rows){if(!rows.length){campaignList.innerHTML='<div class="muted">Nenhuma campanha para estes filtros.</div>';detail.innerHTML='';return}if(!rows.some(c=>c.id===selectedId))selectedId=rows[0].id;campaignList.innerHTML=rows.map(c=>{const ch=c.character?.character||'Personagem indefinido',klass=c.character?.baseClass||c.character?.class||'classe incerta',ver=c.version?.eaVersion||'versao incerta',league=c.league?.name||'Indefinida',maps=c.maps?.endgameMapCount||0;return '<button class="run '+(c.id===selectedId?'active':'')+'" data-id="'+c.id+'"><div class="runTop"><div class="runTitle">'+esc(ch)+'</div><span class="pill">'+esc(ver)+' · '+esc(league)+'</span></div><div class="muted">'+esc(klass)+' · '+fmtDate(c.start)+' · ativo '+fmtDuration(c.activeSeconds??c.wallSeconds)+'</div><div class="muted">'+maps+' mapas endgame · '+(c.passives?.allocatedCount||0)+' passivas alocadas</div></button>'}).join('');campaignList.querySelectorAll('button').forEach(b=>b.onclick=()=>{selectedId=b.dataset.id;render()})}
function bars(title,data,color){const entries=Object.entries(data||{}).sort((a,b)=>b[1]-a[1]).slice(0,10),max=Math.max(1,...entries.map(x=>x[1]));return '<div class="card detail"><h2>'+title+'</h2><div class="bars">'+(entries.map(([l,v])=>'<div class="barRow"><div class="barLabel" title="'+esc(l)+'">'+esc(l)+'</div><div class="barTrack"><div class="barFill" style="width:'+Math.max(1,v/max*100)+'%;background:'+color+'"></div></div><div class="barValue">'+fmtDuration(v)+'</div></div>').join('')||'<div class="muted">Sem dados.</div>')+'</div></div>'}
function countBars(title,data,color){const entries=Object.entries(data||{}).sort((a,b)=>b[1]-a[1]).slice(0,10),max=Math.max(1,...entries.map(x=>x[1]));return '<div class="card detail"><h2>'+title+'</h2><div class="bars">'+(entries.map(([l,v])=>'<div class="barRow"><div class="barLabel" title="'+esc(l)+'">'+esc(l)+'</div><div class="barTrack"><div class="barFill" style="width:'+Math.max(1,v/max*100)+'%;background:'+color+'"></div></div><div class="barValue">'+v+'</div></div>').join('')||'<div class="muted">Sem dados.</div>')+'</div></div>'}
function renderDetail(c){const ch=c.character||{},tags=Object.keys(c.version?.clientTags||{}).join(', ')||'-',rows=(c.characters||[]).map(r=>'<tr><td>'+esc(r.character)+'</td><td>'+esc(r.baseClass||r.class||'-')+'</td><td>'+(r.minLevel??'-')+'-'+(r.maxLevel??'-')+'</td><td>'+r.levelUps+'</td></tr>').join(''),mapNote=(c.maps?.endgameMapEntryCount||0)+' entradas/reentradas';detail.innerHTML='<h2>'+esc(ch.character||c.id)+'</h2><div class="muted">'+fmtDate(c.start)+' ate '+fmtDate(c.end)+(c.duplicateReason?' · duplicada por multiplas ligas em trade whisper':'')+'</div><div class="detailRow">'+[['Versao EA',c.version?.eaVersion||'-',tags],['Liga',c.league?.name||'Indefinida',(c.league?.source||'not_found')+' · '+(c.league?.type||'Unknown')],['Classe inicial',ch.baseClass||ch.class||'-','detectada por level-up'],['Mapas endgame',c.maps?.endgameMapCount||0,mapNote],['Tempo endgame',fmtDuration(c.timing?.endgameSeconds),'somente areas Map*'],['Passivas alocadas',c.passives?.allocatedCount||0,(c.passives?.unallocatedCount||0)+' removidas'],['Tempo ativo',fmtDuration(c.activeSeconds??c.wallSeconds),'areas capadas em 1h'],['Hideout',fmtDuration(c.timing?.hideoutSeconds),''],['AFK',fmtDuration(c.timing?.afkSeconds),''],['Foco perdido / pause proxy',fmtDuration(c.timing?.focusLostSeconds),''],['Passive tree estimado',fmtDuration(c.timing?.passiveTreeSecondsEstimated),''],['Gaps longos',fmtDuration(c.timing?.inactiveGapSeconds),''],['Areas geradas',c.timing?.areaCount||0,'']].map(x=>'<div class="small"><div class="label">'+x[0]+'</div><div class="value">'+esc(x[1])+'</div><div class="muted">'+esc(x[2])+'</div></div>').join('')+'</div><div class="split">'+countBars('Top mapas endgame',c.maps?.endgameMapCounts,'var(--warn)')+bars('Tempo por ato',c.timing?.actSeconds,'var(--good)')+'</div><div class="split">'+bars('Top areas',c.timing?.areaSecondsTop,'var(--accent)')+countBars('Top passivas brutas',c.passives?.topPassives,'var(--cold)')+'</div><div class="card detail"><h2>Personagens candidatos</h2><table><thead><tr><th>Nome</th><th>Classe</th><th>Level</th><th>Ups</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4" class="muted">Sem level-up detectado.</td></tr>')+'</tbody></table></div>'}
function render(){const rows=filtered();renderMetrics(rows);renderList(rows);const selected=rows.find(c=>c.id===selectedId)||rows[0];if(selected)renderDetail(selected)}
source.textContent=analysis.metadata.sourcePath+' · gerado em '+fmtDate(analysis.generatedAt);['search','versionFilter','classFilter','leagueFilter'].forEach(id=>{document.getElementById(id).addEventListener('input',render);document.getElementById(id).addEventListener('change',render)});fillFilters();renderFileFacts();render();
</script>
</body>
</html>`;
}

async function main() {
  const logPath = argValue("--log", DEFAULT_LOG_PATH);
  const jsonPath = argValue("--json", "data/analysis.json");
  const htmlPath = argValue("--html", "dashboard.html");

  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exitCode = 1;
    return;
  }

  const analysis = await makeAnalysis(logPath);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2), "utf8");
  fs.writeFileSync(htmlPath, dashboardHtml(analysis), "utf8");

  console.log(
    `Analyzed ${analysis.summary.campaignCount} campaigns from ${analysis.metadata.lineCount.toLocaleString()} lines.`,
  );
  console.log(`JSON: ${path.resolve(jsonPath)}`);
  console.log(`Dashboard: ${path.resolve(htmlPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
