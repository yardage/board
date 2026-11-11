import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ENVIRONMENT_SECTIONS, isEnvironmentSection, readSettingsHash, SETTINGS_GROUPS, SETTINGS_SECTIONS, toSection } from '../../src/client/features/settings/settings-sections.ts'

describe('the addresses of the settings', () => {
  it('reads back the address of each part', () => {
    for (const section of SETTINGS_SECTIONS) assert.equal(readSettingsHash(toSection(section).slice(1)), section)
  })

  it('opens the first part for the bare address and for a part that no longer exists', () => {
    assert.equal(readSettingsHash('settings'), 'general')
    assert.equal(readSettingsHash('settings/gone'), 'general')
    assert.equal(readSettingsHash('settings/constructor'), 'general', 'a name every object has is still a part that does not exist')
  })

  it('opens the part that took over an address from before', () => {
    assert.equal(readSettingsHash('settings/claude'), 'ai')
    assert.equal(readSettingsHash('settings/models'), 'ai')
    assert.equal(readSettingsHash('settings/app'), 'about')
    assert.equal(readSettingsHash('settings/environment'), 'environment')
  })

  it('leaves the other addresses alone', () => {
    for (const hash of ['', 'vue', 'settingsx', 'rapports', 'd/settings/voice']) assert.equal(readSettingsHash(hash), null)
  })
})

describe('the parts of the settings', () => {
  it('puts every part in one group, this computer’s or everyone’s', () => {
    const grouped = SETTINGS_GROUPS.flatMap((group) => group.sections)
    assert.deepEqual([...grouped].sort(), [...SETTINGS_SECTIONS].sort())
    assert.equal(new Set(grouped).size, grouped.length)
  })

  it('gives everyone the environment’s parts, and only them', () => {
    const everyone = SETTINGS_GROUPS.find((group) => group.title === 'everyone')?.sections
    assert.deepEqual(everyone, [...ENVIRONMENT_SECTIONS])
    assert.ok(isEnvironmentSection('repositories'))
    assert.ok(!isEnvironmentSection('about'))
  })
})
