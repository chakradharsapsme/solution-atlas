# Solution Atlas

Type an SAP application or keyword and get a **mind map** built from official sources, with the **glossary** and **source list** in a separate panel. It runs on your own server and **does not use any AI model**, so there are no tokens to pay for.

## Quick start

```bash
npm install
npm run demo      # offline example data, no key or internet needed → http://localhost:3000
```

For real searches:

```bash
cp .env.example .env    # add BRAVE_API_KEY (or SEARXNG_URL)
npm start               # → http://localhost:3000
npm test                # offline tests
```

Needs Node.js 18.17 or newer.

## Three ways to build a map

| Mode | Where the data comes from | Needs a key? |
|---|---|---|
| **SAP Help Portal (free)** | Uses the SAP Help Portal's own search and content feed (the same ones help.sap.com uses), reads the top 6 topics and adds the main guide's table of contents as a branch. With a Brave or SearXNG key it also adds SAP Community, SAP Learning and api.sap.com | No |
| **General (Wikipedia)** | Uses the Wikipedia article's sections as branches and its linked concepts as the glossary. You can also add an official site domain | No |
| **From a document URL** | Paste an official guide (PDF or web page). The PDF's bookmarks or the page's headings become the map | No |

On any node, **Map this source page** reads that node's page and adds its outline as new sub-topics under the node.

## How it works (no AI)

1. **Search**: one query per official domain (`keyword site:help.sap.com`, …). Results that aren't on the domain asked for are dropped.
2. **Read**: the top pages (8 by default) are fetched politely: the app follows robots.txt, waits between requests to the same site, sends a clear user agent, and caps timeouts and file sizes. PDF bookmarks are read with pdf.js.
3. **Branches**: phrases that appear in several results' titles, snippets and headings are scored, with official documentation weighted above community posts. The top 5–7 become branches, and each result sits under its best-matching branch. Page headings become the next level down.
4. **Glossary**: collected with rules only:
   - acronym patterns such as `Cloud Integration Gateway (CIG)`
   - definition sentences ("X is a …")
   - `<dl>` definition lists, glossary tables and **Bold term:** lines
   - ranked by how often each term is used across the sources

   A term without a definition gets a *Look up definition* button, which uses the Wikipedia summary API.
5. **Cache**: results are saved to `.cache/` for 7 days, so the same keyword never costs a second search.

## Costs

* General and Document modes: free.
* SAP mode: 5 searches per new keyword (one per domain). The Brave Search API includes a monthly free credit, then charges per 1,000 queries. Check Brave's current pricing. Cached keywords cost nothing. Running your own SearXNG costs nothing but server time.
* The server limits each IP to 30 API calls per minute to protect your credit.

## Deploy

Any Node host works (Render, Railway, Fly.io, Azure App Service, a VM). A Docker image is included:

```bash
docker build -t solution-atlas . && docker run -p 3000:3000 --env-file .env solution-atlas
```

## Good to know

* help.sap.com pages load their content with JavaScript, so the app reads them through the portal's own content feed. Pasting a help.sap.com/docs link in Document mode maps that whole guide's table of contents. These feeds are not a published SAP API, so SAP could change them. The app uses them lightly: one search per keyword and a handful of page reads, with results cached for 7 days.
* PDF guide links that contain /LATEST/ always point to the current release.
* Map quality depends on what the search returns. Specific keywords ("SAP Ariba guided buying policies") give tighter maps than broad ones ("SAP").
* The app stores only titles, links and short snippets, and every node links to its source. Check each site's terms of use before you run it as a public service.
* Google's Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, so it isn't used here.

## Project layout

```
server.js          API routes: /api/map, /api/document, /api/define, /api/status
lib/providers.js   Brave, SearXNG, Wikipedia, offline fixtures
lib/http.js        polite fetching, robots.txt, concurrency
lib/extract.js     HTML headings/definitions, PDF outline/text
lib/glossary.js    rule-based glossary harvesting
lib/mapper.js      turns search results, outlines or Wikipedia sections into a map
lib/cache.js       disk + memory cache
public/index.html  the web app (mind map, glossary, sources, export)
test/              offline tests and fixtures
```

## Ideas for next versions

* **Release diff**: map two releases of the same guide and colour what's new or removed.
* **Curated seed lists**: store the best official PDF guides per product so SAP mode starts from them.
* **Workshop export**: turn a branch into discovery questions (.docx or .xlsx).
* **Team notes**: a small database so colleagues can add client-specific notes to nodes.
* **Optional AI polish**: if you want it later, one short model call to tidy branch labels costs far fewer tokens than generating the whole map.
