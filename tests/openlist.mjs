import assert from "node:assert/strict";

const httpBase = process.env.HTTP_URL || "http://127.0.0.1:4311";
const baseUrl = process.env.OPENLIST_URL || "https://al.chirmyram.com";
const directory = "/tlv1/中剧/大明王朝1566/Season 1";
const expectedName = "大明王朝1566.Da.Ming.Wang.Chao.2007.S01E01.1080p.WEB-DL.AAC.H.264-OurTV.mp4";

const browseResponse = await fetch(`${httpBase}/api/openlist/browse`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseUrl, path: directory, query: "S01E01" })
});
assert.equal(browseResponse.status, 200);
const browse = await browseResponse.json();
const selected = browse.items.find((item) => item.name === expectedName);
assert.ok(selected, "OpenList search should return episode 1");
assert.equal(selected.isDir, false);

const resolveResponse = await fetch(`${httpBase}/api/openlist/resolve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseUrl, path: selected.path })
});
assert.equal(resolveResponse.status, 200);
const resolved = await resolveResponse.json();
assert.match(resolved.url, /^https?:\/\//);
assert.equal(resolved.name, expectedName);

const mediaResponse = await fetch(resolved.url, {
  headers: { Range: "bytes=0-31" },
  redirect: "follow"
});
assert.ok([200, 206].includes(mediaResponse.status));
const sample = new Uint8Array(await mediaResponse.arrayBuffer());
assert.ok(sample.length > 0);

console.log(JSON.stringify({
  ok: true,
  searchResults: browse.total,
  selected: resolved.name,
  rangeStatus: mediaResponse.status,
  sampleBytes: sample.length
}));
