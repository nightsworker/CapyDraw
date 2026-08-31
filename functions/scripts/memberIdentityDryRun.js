"use strict";

const fs = require("node:fs");
const {
  CONFIRMED_LEGACY_BINDING_ALIASES,
  INACTIVE_HISTORICAL_MEMBER_IDS,
  buildMigrationProposal,
  resolveLegacyBindingMember,
} = require("../lib/memberIdentity");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function rowLabel(row) {
  return `${row.label || "item"}[${row.index}]=${row.value || "(empty)"}`;
}

function analysisLine(name, analysis) {
  return `${name}: TOTAL=${analysis.total} MAPPED=${analysis.mapped.length} ` +
    `AMBIGUOUS=${analysis.ambiguous.length} UNMAPPED=${analysis.unmapped.length}`;
}

function printRows(title, rows) {
  console.log(`${title}:`);
  if (!rows.length) {
    console.log("- NONE");
    return;
  }
  rows.forEach((row) => console.log(`- ${rowLabel(row)}`));
}

function main() {
  const [mainPath, bindingsPath] = process.argv.slice(2);
  if (!mainPath || !bindingsPath) {
    throw new Error("Usage: node memberIdentityDryRun.js <main.json> <lineBindings.json>");
  }
  const proposal = buildMigrationProposal({
    main: readJson(mainPath),
    bindings: readJson(bindingsPath),
  });
  const report = proposal.report;
  const proposedMembers = Object.values(proposal.mainPatch && proposal.mainPatch.members || {});
  const proposedActive = proposedMembers.filter((member) => member.active);
  const proposedInactive = proposedMembers.filter((member) => !member.active);
  console.log("MEMBER IDENTITY PRODUCTION READ-ONLY DRY-RUN");
  console.log(analysisLine("MEMBERS CURRENT", report.members));
  console.log(`CANONICAL MAPPING: ${report.canonicalCount}`);
  console.log(`MEMBERS EXACT MATCH: ${report.members.mapped.length}`);
  printRows("MEMBERS UNMATCHED", report.members.unmapped);
  printRows("MEMBERS AMBIGUOUS", report.members.ambiguous);
  console.log(`MEMBERS MASTER PROPOSED TOTAL: ${proposedMembers.length}`);
  console.log(`ACTIVE: ${proposedActive.length}`);
  console.log(`INACTIVE: ${proposedInactive.length}`);
  console.log(`INACTIVE HISTORICAL MEMBERS: ${INACTIVE_HISTORICAL_MEMBER_IDS.join(",")}`);
  console.log(analysisLine("HIGH WAR CURRENT", report.highWar));
  console.log(`HIGH WAR MAPPABLE: ${report.highWar.mapped.length}`);
  console.log(analysisLine("CAPTAIN POOL", report.captainPool));
  console.log(analysisLine("GUARDIAN POOL", report.guardianPool));
  console.log(analysisLine("CABIN4 POOL", report.cabin4Pool));
  console.log(`EXCLUSIONS: captain=${report.exclusions.captain.total}/` +
    `${report.exclusions.captain.mapped.length} guardian=${report.exclusions.guardian.total}/` +
    `${report.exclusions.guardian.mapped.length} cabin4=${report.exclusions.cabin4.total}/` +
    `${report.exclusions.cabin4.mapped.length}`);
  console.log(`LINE BINDINGS TOTAL: ${report.bindings.total}`);
  console.log(`LINE BINDINGS MAPPED: ${report.bindings.mapped.length}`);
  console.log(`LINE BINDINGS UNMAPPED: ${report.bindings.unmapped.length}`);
  console.log(`LINE BINDINGS AMBIGUOUS: ${report.bindings.ambiguous.length}`);
  report.bindings.unmapped.forEach((row, index) => {
    console.log(`- UNMAPPED_BINDING_${index + 1}: ${row.result.value || "(empty playerName)"}`);
  });
  report.bindings.ambiguous.forEach((row, index) => {
    console.log(`- AMBIGUOUS_BINDING_${index + 1}: ${row.result.value || "(empty playerName)"} ` +
      `candidates=${row.result.candidateMemberIds.join(",")}`);
  });
  console.log("LEGACY ALIASES SUCCESSFULLY MAPPED:");
  CONFIRMED_LEGACY_BINDING_ALIASES.forEach((alias) => {
    const result = resolveLegacyBindingMember(alias.playerName);
    console.log(`- ${alias.playerName} -> ${result.status === "mapped" ?
      result.member.memberId : "UNRESOLVED"}`);
  });
  console.log(`MULTI CHARACTER LINE USERS: ${report.bindings.multiCharacterUsers.length}`);
  report.bindings.multiCharacterUsers.forEach((user) => {
    console.log(`- ${user.safeUserRef}: ${user.memberIds.join(",")}`);
  });
  console.log(`HISTORY TOTAL: ${report.history.total}`);
  console.log(`HISTORY SAFE TO MIGRATE: ${report.history.safe.length}`);
  console.log(`HISTORY AMBIGUOUS: ${report.history.ambiguous.length}`);
  console.log(`HISTORY UNRESOLVED: ${report.history.ambiguous.length}`);
  console.log(`HISTORY INTERNAL LEGACY REFERENCES: ${report.history.internalUnsafe.length}`);
  report.history.ambiguous.forEach((row) => {
    const issues = [...row.ambiguous, ...row.unmapped]
      .map((issue) => `${issue.role}=${String(issue.value || "")}`).join("; ");
    console.log(`- ${row.date || "NO_DATE"}/${row.recordId || `INDEX_${row.index}`}: ${issues}`);
  });
  console.log(`LEGACY HISTORY PRESERVED: ${proposal.legacyHistoryPreserved ? "YES" : "NO"}`);
  console.log(`HISTORY BLOCKS MEMBER MIGRATION: ${proposal.safety.historyBlocksMigration ?
    "YES" : "NO"}`);
  console.log(`MEMBERS MASTER PRESENT: ${report.hasMembersMaster ? "YES" : "NO"}`);
  console.log(`SAFE TO MIGRATE PRODUCTION: ${proposal.safe ? "YES" : "NO"}`);
  console.log(`SAFE TO MIGRATE MEMBER MASTER: ${proposal.safety.memberMaster ? "YES" : "NO"}`);
  console.log(`SAFE TO MIGRATE LINE BINDINGS: ${proposal.safety.lineBindings ? "YES" : "NO"}`);
  console.log(`SAFE TO MIGRATE POOLS / HIGH WAR / EXCLUSIONS: ${proposal.safety.roleState ?
    "YES" : "NO"}`);
  console.log(`PROPOSED BINDING PATCHES: ${proposal.bindingPatches ?
    Object.keys(proposal.bindingPatches).length : 0}`);
  console.log("PRODUCTION WRITES PERFORMED: NO");
}

main();
