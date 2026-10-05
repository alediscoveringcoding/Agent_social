import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dayLengthHours, groupByDay, isDay, mondayOf, resolveWeek, timeOfDay, weekBoundsUtc, weekDays } from '../calendar.ts'
import { buildHandoff, downloadName, htmlDocument, markdownToHtml, markdownToPlain, textToHtml } from '../handoff.ts'

describe('Bucharest calendar', () => {
  it('steps calendar dates and validates query parameters', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(mondayOf('2026-10-25'), '2026-10-19')
    assert.equal(isDay('2026-02-30'), false)
    assert.equal(resolveWeek('invalid', new Date('2026-10-25T22:30:00Z')), '2026-10-26')
    assert.equal(weekDays('2026-10-19').length, 7)
  })
  it('has 169 hours in the autumn week and 167 in spring', () => {
    for (const [monday, hours, sundayHours] of [['2026-10-19', 169, 25], ['2026-03-23', 167, 23]] as const) {
      const { start, end } = weekBoundsUtc(monday)
      assert.equal((end.getTime() - start.getTime()) / 3_600_000, hours)
      assert.equal(dayLengthHours(addDays(monday, 6)), sundayHours)
    }
  })
  it('groups and sorts both occurrences of the repeated hour into Sunday', () => {
    const entries = ['2026-10-25T01:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T22:00:00Z']
    const grouped = groupByDay(entries, weekDays('2026-10-19'), (x) => x)
    assert.deepEqual(grouped.get('2026-10-25'), entries.slice(0, 2).reverse())
    assert.equal(timeOfDay(entries[0]), '03:30')
    assert.equal(timeOfDay(entries[1]), '03:30')
  })
})

describe('manual handoff formats', () => {
  it('renders the supported markdown blocks and keeps hostile content escaped', () => {
    const html = markdownToHtml('# Titlu\n\n**bold** si [link](https://example.test/)\n\n- unu\n- doi\n\n> citat\n\n```\n<script>alert(1)</script>\n```\n\n[bad](javascript:alert)')
    assert.match(html, /<h1>Titlu<\/h1>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<ul>/)
    assert.match(html, /<blockquote>/)
    assert.match(html, /&lt;script&gt;/)
    assert.doesNotMatch(html, /<script|href="javascript:/)
    assert.match(textToHtml('<img src=x>\nhttps://example.test/'), /&lt;img/)
    assert.equal(markdownToPlain('# Titlu\n\n**bold** [link](https://example.test/)'), 'Titlu\n\nbold link (https://example.test/)')
  })
  it('provides article fields and all launch kit fields', () => {
    const article = buildHandoff({ platform: 'substack', kind: 'article', title: 'Titlu', text: '', settings: {}, article: { subtitle: 'Subtitlu', body_markdown: '**Corp**' } })
    assert.equal(article.body.plain, 'Corp')
    assert.equal(article.body.html, '<p><strong>Corp</strong></p>')
    assert.deepEqual(article.fields.map((f) => f.key), ['title', 'subtitle'])
    const launch = buildHandoff({ platform: 'producthunt', kind: 'launch', title: 'Produs', text: '', settings: {}, launch: { tagline: 'Tagline', description: 'Descriere', maker_comment: 'Comentariu' } })
    assert.deepEqual(launch.fields.map((f) => f.key), ['name', 'tagline', 'description', 'maker_comment'])
    assert.equal(launch.fields[1].max, 60)
    assert.equal(launch.fields[2].max, 260)
  })
  it('creates portable download names and escaped standalone documents', () => {
    assert.equal(downloadName('Declaratia unica', 'substack', 'md'), 'declaratia-unica-substack.md')
    assert.equal(downloadName('!!!', 'x', 'txt'), 'postare-x.txt')
    assert.match(htmlDocument('<unsafe>', '<p>Text</p>'), /<title>&lt;unsafe&gt;<\/title>/)
  })
})
