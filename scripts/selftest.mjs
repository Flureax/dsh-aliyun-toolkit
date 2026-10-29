/**
 * Signing and settings self-test. Run with: node scripts/selftest.mjs
 * No network access is required.
 */
import assert from 'node:assert/strict'
import {
  canonicalQuery,
  ossPresignUrl,
  ossSignature,
  ossStringToSign,
  percentEncode,
  rpcSignature,
  rpcStringToSign,
} from '../src/sign.js'
import { normalizeSettings, validateSettingsPatch } from '../src/settings.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

check('RFC3986 percent encoding', () => {
  assert.equal(percentEncode('a b*c~d'), 'a%20b%2Ac~d')
  assert.equal(percentEncode("!*'()"), '%21%2A%27%28%29')
  assert.equal(percentEncode('/'), '%2F')
  assert.equal(percentEncode('中文'), '%E4%B8%AD%E6%96%87')
})

check('canonical query sorts keys', () => {
  assert.equal(canonicalQuery({ b: '2', a: '1' }), 'a=1&b=2')
  assert.equal(canonicalQuery({ a: undefined, b: 'x y' }), 'b=x%20y')
})

check('RPC string-to-sign and official signature vector', () => {
  const params = {
    AccessKeyId: 'testid',
    Action: 'DescribeRegions',
    Format: 'XML',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
    SignatureVersion: '1.0',
    Timestamp: '2016-02-23T12:46:24Z',
    Version: '2014-05-26',
  }
  const expected =
    'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML' +
    '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf' +
    '%26SignatureVersion%3D1.0%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26'
  assert.equal(rpcStringToSign('GET', params), expected)
  assert.equal(rpcSignature('GET', params, 'testsecret'), 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=')
})

check('OSS string-to-sign', () => {
  const stringToSign = ossStringToSign({
    method: 'PUT',
    contentType: 'text/plain',
    date: 'Wed, 01 Jan 2020 00:00:00 GMT',
    headers: { 'X-OSS-Meta-Tag': 'bar', 'x-oss-meta-author': 'foo' },
    bucket: 'bucket',
    key: 'key',
    subresources: { acl: '' },
  })
  assert.equal(
    stringToSign,
    'PUT\n' +
      '\n' +
      'text/plain\n' +
      'Wed, 01 Jan 2020 00:00:00 GMT\n' +
      'x-oss-meta-author:foo\n' +
      'x-oss-meta-tag:bar\n' +
      '/bucket/key?acl',
  )
  assert.equal(ossSignature({ method: 'GET', date: 'x', bucket: 'b' }, 'secret').length, 28)
})

check('OSS presigned URL shape', () => {
  const url = ossPresignUrl({
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    bucket: 'demo',
    key: 'a/b c.txt',
    accessKeyId: 'LTAI1234',
    accessKeySecret: 'secret',
    expiresSeconds: 60,
  })
  assert.match(url, /^https:\/\/demo\.oss-cn-hangzhou\.aliyuncs\.com\/a\/b%20c\.txt\?OSSAccessKeyId=LTAI1234&Expires=\d+&Signature=/)
})

check('settings normalization falls back instead of throwing', () => {
  const normalized = normalizeSettings({ defaultRegion: 'BAD REGION', writeMode: 'nope', maxResults: 9999 })
  assert.equal(normalized.defaultRegion, 'cn-hangzhou')
  assert.equal(normalized.writeMode, 'ask')
  assert.equal(normalized.maxResults, 200)
  assert.deepEqual(normalized.protectIds, [])
})

check('settings patch validation', () => {
  assert.equal(validateSettingsPatch({ writeMode: 'ask' }).value.writeMode, 'ask')
  assert.ok(validateSettingsPatch({ writeMode: 'always' }).error)
  assert.ok(validateSettingsPatch({ defaultRegion: 'bad region' }).error)
  assert.ok(validateSettingsPatch({ endpointOverrides: { ecs: 'https://x' } }).error)
  assert.deepEqual(validateSettingsPatch({ protectIds: ['i-1'] }).value.protectIds, ['i-1'])
})

check('compute preferences and defaults', () => {
  assert.ok(validateSettingsPatch({ preferences: 'x'.repeat(2001) }).error)
  assert.equal(validateSettingsPatch({ preferences: '渲染用 GPU' }).value.preferences, '渲染用 GPU')
  assert.ok(validateSettingsPatch({ computeSpot: 'yes' }).error)
  assert.ok(validateSettingsPatch({ computeRegion: 'bad region' }).error)
  assert.equal(validateSettingsPatch({ computeRegion: '' }).value.computeRegion, '')
  const normalized = normalizeSettings({
    computeMaxHours: 999,
    computeSpot: false,
    preferences: '  hi  ',
    computeInstanceType: ' ecs.gn6i-c4g1.xlarge ',
    computeAuto: false,
    computeAccelerator: 'gpu',
  })
  assert.equal(normalized.computeMaxHours, 72)
  assert.equal(normalized.computeSpot, false)
  assert.equal(normalized.preferences, 'hi')
  assert.equal(normalized.computeInstanceType, 'ecs.gn6i-c4g1.xlarge')
  assert.equal(normalized.computeAuto, false)
  assert.equal(normalized.computeAccelerator, 'gpu')
  assert.ok(validateSettingsPatch({ computeAuto: 'yes' }).error)
  assert.ok(validateSettingsPatch({ computeAccelerator: 'tpu' }).error)
  assert.equal(validateSettingsPatch({ computeAuto: true }).value.computeAuto, true)
  assert.equal(validateSettingsPatch({ computeAccelerator: 'cpu' }).value.computeAccelerator, 'cpu')
})

console.log(`\n${passed} checks passed`)
