// Runs the compiled contract on an in-memory chain: serve → sip → read, plus every rule in the PRD.
// Usage (from the project root): node tools/compile.mjs && node tools/test-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { abi, bytecode } = JSON.parse(readFileSync(join(root, 'build/CaptionCafe.json'), 'utf8'));

const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 677 } }));
const [chef, fan, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
// ganache under-estimates gas for some writes, so pin it
const GAS = { gasLimit: 1_000_000 };

const cafe = await (await new ContractFactory(abi, bytecode, chef).deploy()).waitForDeployment();
const as = (signer) => cafe.connect(signer);
const events = (receipt) => receipt.logs.map((l) => cafe.interface.parseLog(l)).filter(Boolean);
const reverts = (call, name) => assert.rejects(call, (e) => e.revert?.name === name, `expected ${name}`);

const IG = 0, TIKTOK = 1, X = 2;
const PLAYFUL = 0, FUNNY = 4;

// --- empty state ----------------------------------------------------
assert.equal(await cafe.total(), 0n);
assert.deepEqual([...(await cafe.getCaptions(0, 20))], []);
assert.deepEqual([...(await cafe.sippedBy(fan.address, 0, 20))], []);
await reverts(cafe.getCaption(0), 'NotFound');
await reverts(as(fan).sip.staticCall(0), 'NotFound');

// --- serve validation -----------------------------------------------
await reverts(as(chef).serve.staticCall('Bean There', '', '#coffee', IG, PLAYFUL), 'EmptyText');
await reverts(as(chef).serve.staticCall('x'.repeat(41), 'Hi', '', IG, PLAYFUL), 'TooLong');
await reverts(as(chef).serve.staticCall('Cafe', 'x'.repeat(300), 'y'.repeat(17), IG, PLAYFUL), 'TooLong'); // 4 + 300 + 17 = 321
await reverts(as(chef).serve.staticCall('Cafe', 'Hi', '', IG, 5), 'BadTone');
await assert.rejects(as(chef).serve.staticCall('Cafe', 'Hi', '', 3, PLAYFUL), 'platform out of range must revert');
// exactly at the limits is fine (multi-byte characters count as bytes)
await as(chef).serve.staticCall('x'.repeat(40), 'x'.repeat(260), 'y'.repeat(20), IG, PLAYFUL);
await reverts(as(chef).serve.staticCall('', '☕'.repeat(107), '', IG, PLAYFUL), 'TooLong'); // 3 bytes each → 321

// --- serve ----------------------------------------------------------
let r = await (await as(chef).serve('Bean There', 'Iced oat latte, but make it a whole mood.', '#icedlatte #oatmilk', IG, PLAYFUL, GAS)).wait();
console.log(`serve gas: ${r.gasUsed}`);
let [ev] = events(r);
assert.equal(ev.name, 'Served');
assert.deepEqual([ev.args.id, ev.args.chef, ev.args.platform], [0n, chef.address, 0n]);

await (await as(fan).serve('Crumb Club', 'Croissant o’clock. ☕', '#croissant', X, FUNNY, GAS)).wait();
await (await as(chef).serve('', 'No business name needed.', '', TIKTOK, 2, GAS)).wait();
assert.equal(await cafe.total(), 3n);

const c0 = await cafe.getCaption(0);
assert.equal(c0.chef, chef.address);
assert.equal(c0.business, 'Bean There');
assert.equal(c0.text, 'Iced oat latte, but make it a whole mood.');
assert.equal(c0.hashtags, '#icedlatte #oatmilk');
assert.equal(c0.platform, 0n);
assert.equal(c0.tone, 0n);
assert.equal(c0.sips, 0n);
assert.ok(c0.servedAt > 0n);
assert.equal((await cafe.captions(1)).text, 'Croissant o’clock. ☕');

assert.deepEqual([...(await cafe.captionsOf(chef.address))], [0n, 2n]);
assert.deepEqual([...(await cafe.captionsOf(fan.address))], [1n]);
assert.deepEqual([...(await cafe.captionsOf(other.address))], []);

// --- paging ---------------------------------------------------------
assert.equal((await cafe.getCaptions(0, 20)).length, 3);
assert.deepEqual((await cafe.getCaptions(1, 1)).map((c) => c.business), ['Crumb Club']);
assert.equal((await cafe.getCaptions(2, 50)).length, 1);
assert.equal((await cafe.getCaptions(3, 5)).length, 0);
assert.equal((await cafe.getCaptions(99, 5)).length, 0);

// --- sip ------------------------------------------------------------
r = await (await as(fan).sip(0, GAS)).wait();
console.log(`sip gas: ${r.gasUsed}`);
[ev] = events(r);
assert.equal(ev.name, 'Sipped');
assert.deepEqual([ev.args.id, ev.args.by, ev.args.sips], [0n, fan.address, 1n]);
await reverts(as(fan).sip.staticCall(0), 'AlreadySipped');
await (await as(chef).sip(0, GAS)).wait(); // sipping your own caption is allowed
await (await as(other).sip(0, GAS)).wait();
await (await as(other).sip(2, GAS)).wait();
assert.equal((await cafe.getCaption(0)).sips, 3n);
assert.equal((await cafe.getCaption(1)).sips, 0n);
assert.equal(await cafe.sipped(0, fan.address), true);
assert.equal(await cafe.sipped(1, fan.address), false);
assert.deepEqual([...(await cafe.sippedBy(other.address, 0, 10))], [true, false, true]);
assert.deepEqual([...(await cafe.sippedBy(other.address, 1, 1))], [false]);
await reverts(as(fan).sip.staticCall(3), 'NotFound');

// --- no admin, no payments ------------------------------------------
const names = cafe.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name).sort();
assert.deepEqual(names, ['MAX_BUSINESS', 'MAX_TOTAL', 'TONES', 'captions', 'captionsOf', 'getCaption', 'getCaptions', 'serve', 'sip', 'sipped', 'sippedBy', 'total']);
assert.ok(cafe.interface.fragments.every((f) => !f.payable), 'nothing is payable');

console.log('all contract tests passed');
