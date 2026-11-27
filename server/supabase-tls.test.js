import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import test from 'node:test'
import pg from 'pg'
import { postgresConnectionOptions } from './supabase-tls.js'

test('shared Supabase pooler uses the vendor CA and verifies peer identity', () => {
  const url = 'postgresql://workspace_gateway.example@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&application_name=mydev'
  const config = postgresConnectionOptions(url)
  const client = new pg.Client(config)
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true)
  assert.equal(client.host, 'aws-1-eu-west-1.pooler.supabase.com')
  assert.equal(client.connectionParameters.application_name, 'mydev')
  const root = new X509Certificate(client.connectionParameters.ssl.ca)
  assert.match(root.subject, /CN=Supabase Root 2021 CA/)
  assert.equal(root.fingerprint256, '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA')
  assert.ok(createSecureContext(client.connectionParameters.ssl))
})

test('other providers and explicit trust configuration retain their connection settings', () => {
  for (const connectionString of [
    'postgresql://workspace_gateway@pg.example.test/postgres?sslmode=verify-full',
    'postgresql://workspace_gateway@aws-1-eu-west-1.pooler.supabase.com.example.test/postgres',
    'postgresql://workspace_gateway@aws-1-eu-west-1.pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=%2Fca.pem',
  ]) {
    assert.deepEqual(postgresConnectionOptions(connectionString), { connectionString })
  }
})

test('the hosted pooler uses transaction mode and retains certificate verification', () => {
  const config = postgresConnectionOptions('postgresql://role@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full', { serverless:true })
  const client = new pg.Client(config)
  assert.equal(client.port,6543)
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true)
})
