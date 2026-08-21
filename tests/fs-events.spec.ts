/**
 * Client fs-events pure invalidation helpers (node env, no DOM): deciding
 * WHAT a host burst invalidates — the visible tree listings, the expanded
 * dirs an unlink destroys, and the editor's open path — must never depend on
 * platform separator style, so both POSIX and Windows paths are covered here.
 */
import { describe, expect, it } from 'vitest'
import {
  changeMatchesPath,
  treeVisibleImpact,
  unlinkCoversPath,
  unlinkedExpandedDirs,
  type FsWatchEvent,
} from '../src/client/fs-events.ts'
import { normalizeFsPath, parentDirOf } from '../src/fs-path.ts'

const change = (path: string): FsWatchEvent => ({ kind: 'change', path })
const add = (path: string): FsWatchEvent => ({ kind: 'add', path })
const unlink = (path: string): FsWatchEvent => ({ kind: 'unlink', path })
const unlinkDir = (path: string): FsWatchEvent => ({ kind: 'unlinkDir', path })

describe('fs path helpers', () => {
  it('normalizeFsPath unifies separators and trims trailing ones', () => {
    expect(normalizeFsPath('/work///a.ts')).toBe('/work/a.ts')
    expect(normalizeFsPath('C:\\work\\a.ts')).toBe('C:/work/a.ts')
    expect(normalizeFsPath('C:\\work\\')).toBe('C:/work')
  })

  it('parentDirOf returns the parent with the platform meaning preserved', () => {
    expect(parentDirOf('/work/a.ts')).toBe('/work')
    expect(parentDirOf('/work/src')).toBe('/work')
    expect(parentDirOf('C:/work/a.ts')).toBe('C:/work')
    expect(parentDirOf('/')).toBe('/')
  })
})

describe('treeVisibleImpact', () => {
  it('a file event in the workspace root listing counts (POSIX + Windows)', () => {
    expect(treeVisibleImpact([change('/work/a.ts')], '/work', [])).toBe(true)
    expect(treeVisibleImpact([add('C:/work/a.ts')], 'C:\\work', [])).toBe(true)
  })

  it('an event inside an expanded dir counts', () => {
    expect(treeVisibleImpact([unlink('/work/src/a.ts')], '/work', ['/work/src'])).toBe(true)
  })

  it('an event on an expanded dir itself counts (it was removed/renamed)', () => {
    expect(treeVisibleImpact([unlinkDir('/work/src')], '/work', ['/work/src'])).toBe(true)
  })

  it('events in unexpanded subtrees do NOT count', () => {
    expect(treeVisibleImpact([change('/work/node_modules/x/y.ts')], '/work', ['/work/src'])).toBe(false)
    expect(treeVisibleImpact([change('/work/src/a.ts')], '/work', [])).toBe(false)
  })

  it('an empty batch or missing root never counts', () => {
    expect(treeVisibleImpact([], '/work', [])).toBe(false)
    expect(treeVisibleImpact([change('/work/a.ts')], undefined, [])).toBe(false)
  })

  it('a Windows separator event matches a POSIX-style expanded set', () => {
    expect(treeVisibleImpact([add('C:\\work\\src\\new.ts')], 'C:\\work', ['C:/work/src'])).toBe(true)
  })
})

describe('unlinkedExpandedDirs', () => {
  it('returns the expanded dir that was itself unlinked', () => {
    expect(unlinkedExpandedDirs([unlinkDir('/work/src')], ['/work', '/work/src'])).toEqual(['/work/src'])
  })

  it('returns expanded dirs nested under a removed directory', () => {
    expect(unlinkedExpandedDirs([unlinkDir('/work/src')], ['/work', '/work/src/deep']))
      .toEqual(['/work/src/deep'])
  })

  it('a file unlink inside an expanded dir does not prune the dir', () => {
    expect(unlinkedExpandedDirs([unlink('/work/src/a.ts')], ['/work/src'])).toEqual([])
  })

  it('unrelated removals prune nothing', () => {
    expect(unlinkedExpandedDirs([unlinkDir('/other')], ['/work/src'])).toEqual([])
  })
})

describe('unlinkCoversPath / changeMatchesPath', () => {
  it('an unlink of the exact path covers it', () => {
    expect(unlinkCoversPath(unlink('/work/a.ts'), '/work/a.ts')).toBe(true)
  })

  it('an unlinkDir of an ancestor covers a nested file', () => {
    expect(unlinkCoversPath(unlinkDir('/work/src'), '/work/src/a.ts')).toBe(true)
    expect(unlinkCoversPath(unlink('/work/src/a.ts'), '/work/src/a.ts')).toBe(true)
  })

  it('an unlink of a sibling does not cover the file', () => {
    expect(unlinkCoversPath(unlink('/work/b.ts'), '/work/a.ts')).toBe(false)
  })

  it('a change event never covers via unlink semantics and matches only the exact path', () => {
    expect(unlinkCoversPath(change('/work/a.ts'), '/work/a.ts')).toBe(false)
    expect(changeMatchesPath(change('/work/a.ts'), '/work/a.ts')).toBe(true)
    expect(changeMatchesPath(change('/work/a.ts'), '/work/b.ts')).toBe(false)
    expect(changeMatchesPath(change('/work/src/a.ts'), '/work/a.ts')).toBe(false)
  })

  it('Windows-separator paths match their POSIX twins', () => {
    expect(unlinkCoversPath(unlink('C:\\work\\a.ts'), 'C:/work/a.ts')).toBe(true)
    expect(changeMatchesPath(change('C:\\work\\a.ts'), 'C:/work/a.ts')).toBe(true)
  })
})