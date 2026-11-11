import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { htmlAsWords, wordsOfHtml } from '../../src/client/lib/html-words.ts'

describe('HTML in a body written on GitHub', () => {
  it('keeps the words, without the tags, the comments or the entities', () => {
    assert.equal(wordsOfHtml('<p><b>Please approve</b> the migration &amp; go.</p>').trim(), 'Please approve the migration & go.')
    assert.equal(wordsOfHtml('<!-- template --><!-- unclosed').trim(), '')
    assert.equal(wordsOfHtml('a&#39;b&#x41;&nbsp;c &bogus;').trim(), "a'bA c &bogus;")
  })

  it('keeps the rows of a block on their own lines', () => {
    assert.deepEqual(wordsOfHtml('<details><summary>Notes</summary><ul><li>A</li><li>B</li></ul></details>').split('\n').map((line) => line.trim()).filter(Boolean), ['Notes', 'A', 'B'])
  })

  it('turns a block into paragraphs and an inline tag into text, and drops one with no words', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'html', value: '<p>One</p>\n\n<p>Two</p>' },
        { type: 'paragraph', children: [{ type: 'text', value: 'a ' }, { type: 'html', value: '<code>' }, { type: 'text', value: 'b' }, { type: 'html', value: '</code>' }] },
        { type: 'html', value: '<!-- nothing -->' },
      ],
    }
    htmlAsWords()(tree)
    assert.deepEqual(tree.children, [
      { type: 'paragraph', children: [{ type: 'text', value: 'One' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Two' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'a ' }, { type: 'text', value: 'b' }] },
    ])
  })
})
