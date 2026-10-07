# Visibility channels: where we can post, and which have an API

| | |
| --- | --- |
| Date | 2026-10-07 |
| Scope | The owner's list of about 100 sites (Romanian press, forums, directories, review sites, startup databases, launch platforms, registries). For each: can we **post** there repeatedly, is there an **API**, and how this app covers it. |
| Related | [Amendment 04](amendment-04-more-platforms.md) (every Postiz provider), [Amendment 05](amendment-05-manual-channels.md) (manual channels: Quora, LinkedIn articles, TradingView, Investing.com, Indie Hackers, Stack Exchange, GitHub, forums, press) |

**How to read the API column.** *Write API*: an official API that can publish. *Read API*: data only. *Partner API*: given to vetted partners only. *None*: no official API found. Rows marked ✓ were checked on the web on 2026-10-07 (sources at the end); the others are from what is publicly known and should be re-checked before relying on them.

**The short answer.** Only a handful of these sites can be posted to repeatedly, and fewer still have a publishing API. Most of the list is **one-time listings** (a profile in a directory, a review site, a startup database or a company registry): you create or claim the profile once, and there is nothing to post afterwards. The app covers what can be posted; the listings are a checklist (section 5).

## 1. Already covered by a platform in the app

| Site | API | In the app |
| --- | --- | --- |
| Google Business Profile | Write API (Business Profile APIs) | `gmb`, automatic through Postiz |
| LinkedIn Company Page | Write API (Community Management API, needs LinkedIn approval) | `linkedin-page`, automatic through Postiz once approved |
| Reddit r/Romania, r/RoInvestitii, r/eupersonalfinance, r/Trading212, r/interactivebrokers, r/eToro | Write API (Reddit) | `reddit`, automatic through Postiz; the subreddit is a field of the post (suggested in the composer). Read each subreddit's rules first: most limit self-promotion |
| YouTube | Write API (video upload) | `youtube`, manual: it needs video, which the app does not make |
| Medium | Write API, **closed to new users** ✓: Medium stopped issuing integration tokens on 2025-01-01 | `medium` through Postiz works only with a token created before 2025. Without one, create the Medium account in **manual** mode |
| Substack | None | `substack`, manual |
| Product Hunt (Coming Soon / launch) | Read API ✓; write access only on request, and not for creating launches | `producthunt`, manual |

## 2. Channels added as manual platforms (amendment 05)

You post here repeatedly. None has a usable publishing API (or one we choose not to automate), so the app drafts the text and gives a manual handoff with a checklist.

| Site | API | In the app |
| --- | --- | --- |
| Quora | None ✓ (only third-party scrapers) | `quora`: answer to a question or post in a Space |
| LinkedIn Articles | None for articles and newsletters ✓ (the Posts API does posts and link shares only) | `linkedin-article` |
| TradingView | None for publishing Ideas or Minds ✓ | `tradingview`: an Idea on a symbol |
| Investing.com | None | `investing`: a community post on an instrument page |
| Indie Hackers | None ✓ | `indiehackers` |
| Money Stack Exchange | Write API ✓ (`/questions/add`, `/answers/add`, `write_access`, app registered on Stack Apps) | `stackexchange`, kept manual: self-promotion rules require disclosing the affiliation in every answer |
| GitHub (own repository) | Write API (REST releases, GraphQL `createDiscussion`) | `github`: a release note or a Discussion. Manual for now; the API makes it a good first direct integration |

## 3. Press: one `press` account per outlet

None of these has an API for contributions. A press release or guest article goes to the editors (email or contact form); some outlets publish paid advertorials. In the app, each outlet is an account of the `press` platform (its contact page as the editor link): one press release is drafted once and handed off per outlet, and the published URL is recorded.

| Outlet | Focus |
| --- | --- |
| StartupCafe.ro | startups, grants, small business |
| Wall-Street.ro | business and finance |
| Ziarul Financiar | business daily |
| Profit.ro | business and finance |
| Economica.net | economy |
| Bursa.ro | financial daily |
| Capital.ro | business magazine |
| Forbes Romania | business magazine |
| Economedia.ro | economy (publisher of Profit.ro and others) |
| SpotMedia.ro | news and analysis |
| FinancialIntelligence.ro | business news |
| DCBusiness.ro | business news |
| Business24.ro | business news |
| IncomeMagazine.ro | business and personal finance |
| CursDeGuvernare.ro | economic policy |
| Panorama.ro | news and opinion |
| Ziare.com | news aggregator: articles reach it through the outlets it carries |
| Bancherul.ro | banking news (its forum is a `forum` account) |
| AvocatNet.ro | legal news for business |
| Juridice.ro | legal portal; accepts specialist articles |
| LegeStart.ro | legal and tax news |
| Fiscalitatea.ro | tax news |
| PortalContabilitate.ro | accounting portal; specialist articles |
| Contabilul.ro | accounting portal |
| Contzilla.ro | personal finance comparisons and blog |
| Financer.ro | financial comparisons |
| RomanianStartups.com | startup news (also a directory, section 5) |

## 4. Forums: one `forum` account per forum

| Forum | API |
| --- | --- |
| Forum Softpedia | None |
| Rankia Romania | None |
| Bancherul.ro forum | None |

## 5. One-time listings (outside the app)

Nothing to post repeatedly: create or claim the profile once, keep it current, and ask customers for reviews where it applies. An in-app tracker for these (status, profile URL, last checked) could be added later; for now this is the checklist.

### Software directories and review sites

| Site | API | Note |
| --- | --- | --- |
| G2 | Partner API ✓ (review syndication, read) | free vendor profile |
| Capterra, GetApp, Software Advice | None for vendors to publish | one Gartner Digital Markets vendor profile covers all three |
| TrustRadius | Read API for vendors | vendor profile |
| Trustpilot | Business APIs ✓ (review invitations, replies to reviews; business login) | claim the company; reviews come from customers |
| Sitejabber | None | claim the business |
| FinancesOnline | None | vendor profile |
| AlternativeTo | None | submit the product as an alternative |
| SaaSHub | None for submissions | submit the product |
| Slant.co | None | add as an option in relevant questions |
| Slashdot Software | None | vendor listing (Slashdot Media, same group as SourceForge) |
| SourceForge | Write API ✓ (Allura REST: tickets, wiki, blog posts with a bearer token) | project page; its blog could become a direct integration later |
| Softpedia | None | software download listing; relevant only for downloadable software |
| Tekpon, Crozdesk, SaaSworthy, SoftwareSuggest, SoftwareWorld | None | vendor profiles |

### Launch platforms

| Site | API | Note |
| --- | --- | --- |
| BetaList | None | submit before launch |
| Uneed | Read API for tool discovery ✓; submission by form | launch day |
| Fazier | A public API is advertised ✓, scope not confirmed; submission by form | launch day |
| PeerPush | None found ✓; free or paid submission | launch listing |
| Startup Stash | None | directory submission |

### Startup databases and communities

| Site | API | Note |
| --- | --- | --- |
| Crunchbase | Read API (paid) | company profile, edited on the site |
| Wellfound | None | company profile |
| F6S | None found | company profile, programmes |
| Tracxn | Read API for clients | claim the profile |
| Seedtable, StartupBlink | None | listing |
| RomanianStartups.com | None | startup profile |
| ROTSA ✓ | None | Romanian tech startups association: membership, Founders Club events, Romania Startup Awards |
| Startarium ✓ | None | entrepreneurs' platform (courses, mentors, community); contributions through partnership |
| Indie Hackers product page | None | product profile next to the posts of section 2 |

### Romanian company registries

They fill themselves from public records (ONRC, ANAF); at most, claim the company and complete the contact details.

| Site | API |
| --- | --- |
| termene.ro | Read API ✓ (company data by CUI, Basic auth, paid after a free quota) |
| ListaFirme.ro, Firme.info, Confidas.ro, TopFirme.com, InfoCUI.ro, Targetare.ro, Firmeo.ro, RisCo.ro | None for publishing (some sell data access) |

### Business directories and maps

| Site | API | Note |
| --- | --- | --- |
| Bing Places for Business | Partner API ✓ (verified partners, chains) | for one business, use the portal; it can import the Google Business Profile |
| Pagini Aurii, roLocal (YellowPages.ro), Cylex Romania, ClubAfaceri.ro, e-Oferta.ro, Europages | None | free listings; paid upgrades exist |

### Other

| Site | API | Note |
| --- | --- | --- |
| Wikidata | Write API (MediaWiki Action API, `wbeditentity`) | an item about the company, not a post channel. Notability and conflict-of-interest rules apply: add only sourced facts, by hand |
| BrokerChooser | None | reviews brokers; relevant only for a partnership or a mention |
| SlideShare | No current public API found ✓ (the old upload API's libraries are archived) | upload decks by hand |

## 6. Events: APIs exist, not built

| Site | API | Note |
| --- | --- | --- |
| Eventbrite | Write API ✓ (`POST /v3/organizations/{id}/events/`, then a ticket class, then publish) | an event needs a date, a venue and tickets, which this app's posts do not have |
| Meetup | Write API ✓ (GraphQL `https://api.meetup.com/gql`; organiser of the group, and a Meetup Pro subscription to manage events) | same |

Events would need their own content type (date, place, tickets). They are left for a later amendment.

## 7. What could be automated next

In order of value for effort:

1. **GitHub** release notes and Discussions: a token, a REST or GraphQL call, no approval process.
2. **SourceForge** project blog (Allura REST API with a bearer token).
3. **Eventbrite** and **Meetup** events, once events are a content type.
4. **Stack Exchange** only if the owner accepts the self-promotion constraints (an app registered on Stack Apps, with the affiliation disclosed in every post).

Postiz has none of these. Each would be the first direct integration (the worker calling the platform itself, under the same approval hash).

## Sources (checked 2026-10-07)

- Medium tokens: [n8n Medium credentials](https://docs.n8n.io/integrations/builtin/credentials/medium/), [Medium help: API importing](https://help.medium.com/hc/en-us/articles/213480228-API-Importing)
- LinkedIn articles: [LinkedIn Posts API (Microsoft Learn)](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares)
- Product Hunt: [Product Hunt API 2.0](https://www.producthunt.com/v2/docs)
- Stack Exchange: [write access](https://api.stackexchange.com/docs/write)
- Eventbrite: [creating an event](https://www.eventbrite.co/platform/docs/create-events)
- Meetup: [Meetup GraphQL API summary](https://jentic.com/apis/meetup.com/meetup)
- SourceForge: [API docs](https://sourceforge.net/api-docs/), [Allura REST API](https://forge-allura.apache.org/rest-api-docs/)
- termene.ro: [API documentation](https://termene.ro/documentatie-api)
- G2: [review syndication](https://documentation.g2.com/partners/docs/get-started-with-g2-review-syndication)
- Trustpilot: [developers](https://developers.trustpilot.com/), [Invitation API](https://apis.apievangelist.com/store/trustpilot-invitation-api)
- Bing Places: [overview (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/5672165/bing-places-for-business-overview)
- Quora: no official API; only scrapers such as [Bright Data](https://docs.brightdata.com/api-reference/scrapers/social-media-apis/quora.md)
- TradingView: [publishing ideas](https://www.tradingview.com/support/solutions/43000591338-publishing-and-updating-ideas/)
- Indie Hackers: no official API; posting guide [here](https://skills.sh/sales-skills/sales/sales-indiehackers)
- Uneed, Fazier, PeerPush: [Uneed](https://www.stork.ai/en/uneed), [Fazier](https://www.stork.ai/en/fazier), [PeerPush](https://peerpush.com/about)
- ROTSA: [Revista Biz](https://www.revistabiz.ro/rotsa-se-extinde-la-constanta/)
- Startarium: [Gandul](https://www.gandul.ro/financiar/business/antreprenori/parteneriat-zitec-se-alatura-comunitatii-de-start-up-uri-startarium-antreprenorii-vor-beneficia-de-noi-functionalitati-19615948)
- SlideShare: [archived client library](https://github.com/cleder/slideshare)
