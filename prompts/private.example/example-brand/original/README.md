# Original briefs

`original/<platform>.md` holds the owner's own brief for one platform: the prompt the owner used before the app existed, adapted to it. It is the strongest voice signal in the pack. The file is loaded only when that platform is targeted (`linkedin-page` uses `linkedin.md`), after the platform rules and before the examples, under the heading "OWNER'S ORIGINAL BRIEF FOR <platform>". Each file is cut at about 24,000 characters. This README is never loaded.

What goes in it: audience, the story types to choose and leave out, the 1-10 audit filter, hook formulas, body structure, language rules, examples and the final checklist, in the owner's words.

What to remove or rewrite before saving it:
- Rendering instructions (HTML, fonts, pixel sizes). The app renders cards from the card fields: `headline` (at most 70 characters), `keyword` (the accent word, which must appear in the headline), `stat`, `subline` and `template`.
- Interactive steps ("wait for my choice", "show a table first", "attach the avatar"). The app writes drafts that a person reviews.
- "Sources for the first comment". Sources go in the draft's `sources` ids; no links in the body.
- Anything the app's content rules forbid, for example diacritics in Romanian posts.

Start the file with three lines: whose brief it is; that the app's output schema, content rules and the adaptations override the text where they conflict; and what the app does differently. Mark each adaptation "In aplicatie" (or the language of the file) so the writer can tell them from the original.

Second-level headings (`##`) that contain "tipuri de stiri", "story types", "audit", "selectie", "selection", "acuratete", "accuracy", "fapte" or "facts" (case and accents ignored) are also sent to the research call, so it picks and checks stories the way the owner would.

Placeholder:

```
# [Whose brief this is, platform and language of the posts]
# The app's output schema, content rules and the "In aplicatie" adaptations win over this text.
# [What the app does differently: drafts reviewed by a person, cards from fields, sources by id]

## 1. [Audience]
## 2. [Story types to choose and leave out, and the audit filter]
## 3. [Accuracy]
## 4. [Hook formulas and body structure]
## 5. [Card fields]
## 6. [Final checklist]
```

Never commit a real brief.
