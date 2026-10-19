// Checks that the ABI written into index.html matches the compiled contract, then drives the
// frontend's exact read and write calls against an in-memory chain with BOT Chain's chain ID (677).
// Usage (from the project root): node tools/compile.mjs && node tools/check-frontend.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Interface } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const artifact = JSON.parse(readFileSync(join(root, 'build/CaptionCafe.json'), 'utf8'));

// Pull the ABI array out of index.html and evaluate it as plain JS.
const start = html.indexOf('const ABI = [');
assert.ok(start >= 0, 'ABI not found in index.html');
const tupleLine = html.match(/const CAPTION_TUPLE = '[^']+';/)[0];
const ABI = new Function(`${tupleLine}\n${html.slice(start, html.indexOf('];', start) + 2)}\nreturn ABI;`)();

// 1) Every fragment the site uses must exist in the compiled contract with the same types.
const site = new Interface(ABI);
const real = new Interface(artifact.abi);
for (const f of site.fragments) {
  const match = real.fragments.find((r) => r.type === f.type && r.format('minimal') === f.format('minimal'));
  assert.ok(match, `index.html ${f.type} does not match the contract: ${f.format('full')}`);
}
console.log(`ABI: ${site.fragments.length} fragments match the compiled contract`);

// 2) The site's limits mirror the contract's.
const onchain = html.match(/const ONCHAIN = \{ total: (\d+), business: (\d+) \}/);
assert.ok(onchain, 'ONCHAIN limits not found in index.html');

// 3) Run the site's calls on a chain.
const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 677 } }));
const [chef, fan] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
const GAS = { gasLimit: 1_000_000 };
const deployed = await (await new ContractFactory(real, artifact.bytecode, chef).deploy()).waitForDeployment();
assert.equal(String(await deployed.MAX_TOTAL()), onchain[1], 'ONCHAIN.total matches MAX_TOTAL');
assert.equal(String(await deployed.MAX_BUSINESS()), onchain[2], 'ONCHAIN.business matches MAX_BUSINESS');
const address = await deployed.getAddress();
const asChef = new Contract(address, ABI, chef);
const asFan = new Contract(address, ABI, fan);
const reader = new Contract(address, ABI, provider);

// serve, exactly like chainStore.serve: parse the Served log for the id
const receipt = await (await asChef.serve('Bean There', 'Iced oat latte, but make it a whole mood. ✨', '#icedOatLatte #beanThere', 0, 0, GAS)).wait();
const served = receipt.logs.map((l) => { try { return asChef.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Served');
assert.equal(Number(served.args.id), 0);

// reads exactly as chainStore.all / get / sippedBy do
assert.equal(Number(await reader.total()), 1);
const [c] = await reader.getCaptions(0, 100);
assert.deepEqual([c.chef, c.business, c.text, c.hashtags, Number(c.platform), Number(c.tone), Number(c.sips)],
  [chef.address, 'Bean There', 'Iced oat latte, but make it a whole mood. ✨', '#icedOatLatte #beanThere', 0, 0, 0]);
assert.equal((await reader.getCaption(0)).text, c.text);
await assert.rejects(reader.getCaption(9), (e) => e.revert?.name === 'NotFound');

// sip with the staticCall pre-check, like chainStore.sip
await asFan.sip.staticCall(0);
await (await asFan.sip(0, GAS)).wait();
await assert.rejects(asFan.sip.staticCall(0), (e) => e.revert?.name === 'AlreadySipped');
assert.deepEqual([...(await reader.sippedBy(fan.address, 0, 100))], [true]);
assert.deepEqual([...(await reader.sippedBy(chef.address, 0, 100))], [false]);
assert.equal(Number((await reader.getCaption(0)).sips), 1);
assert.deepEqual([...(await reader.captionsOf(chef.address))], [0n]);

// a too-long serve reverts with the error the site explains
await assert.rejects(asChef.serve.staticCall('', 'x'.repeat(321), '', 2, 1), (e) => e.revert?.name === 'TooLong');

console.log('frontend calls work against the compiled contract');
