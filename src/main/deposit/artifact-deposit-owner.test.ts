import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createArtifactDepositOwner,
  createFileArtifactPublicationStore,
  type ArtifactDepositSource
} from './artifact-deposit-owner'
import { DepositOutcomeUnknownError, type DepositProvider } from './deposit-provider'

const source = (overrides: Partial<ArtifactDepositSource> = {}): ArtifactDepositSource => ({
  artifact: {
    projectId: 'project-1',
    sessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    filename: 'report.csv',
    checksum: 'a'.repeat(64),
    sizeBytes: 120,
    contentType: 'text/csv',
    createdAt: '2026-09-10T00:00:00.000Z'
  },
  session: { title: 'Climate analysis', description: 'Analysis of climate observations.' },
  contributors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }],
  license: { id: 'cc-by-4.0', name: 'Creative Commons Attribution 4.0' },
  relatedIdentifiers: [],
  crate: {
    filename: 'report.csv.ro-crate.zip',
    checksum: 'b'.repeat(64),
    sizeBytes: 2048,
    bytes: new Uint8Array([1, 2, 3])
  },
  ...overrides
})

const fakeProvider = (): DepositProvider => ({
  id: 'zenodo',
  preview: ({ source: value, environment, lineage }) => ({
    schemaVersion: 1,
    provider: 'zenodo',
    environment,
    artifact: value.artifact,
    metadata: {
      title: value.session.title,
      description: value.session.description,
      version: `v${value.artifact.versionNumber}`,
      contributors: value.contributors,
      relatedIdentifiers: value.relatedIdentifiers,
      license: value.license
    },
    providerMetadata: { title: value.session.title },
    files: [
      {
        filename: value.crate.filename,
        sizeBytes: value.crate.sizeBytes,
        checksum: value.crate.checksum,
        contentType: 'application/zip' as const
      }
    ],
    endpoints: [
      {
        purpose: 'create-draft',
        method: 'POST',
        url: 'https://sandbox.zenodo.org/api/deposit/depositions',
        urlKind: 'fixed'
      }
    ],
    warnings: [],
    ...(lineage ? { lineage } : {})
  }),
  execute: vi.fn(async () => ({
    providerRecordId: '700',
    providerConceptRecordId: '699',
    conceptDoi: '10.5072/zenodo.699',
    versionDoi: '10.5072/zenodo.700',
    landingUrl: 'https://sandbox.zenodo.org/records/700'
  })),
  reconcile: vi.fn(async () => ({ state: 'not-found' as const }))
})

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('artifact deposit owner', () => {
  it('previews before upload and requires an explicit approval for the exact preview', async () => {
    const provider = fakeProvider()
    const read = vi.fn(async () => source())
    const token = vi.fn(async () => 'secret-token')
    const owner = createArtifactDepositOwner({
      sourceReader: { read },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: token },
      publicationStore: {
        findLatestForArtifact: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        findByVersion: vi.fn(async () => undefined)
      }
    })
    const request = {
      artifact: {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      provider: 'zenodo' as const
    }
    const preview = await owner.prepare(request)
    expect(preview.environment).toBe('sandbox')
    expect(preview.previewChecksum).toMatch(/^[a-f0-9]{64}$/u)
    expect(token).not.toHaveBeenCalled()
    expect(provider.execute).not.toHaveBeenCalled()

    await expect(
      owner.execute(preview, { outcome: 'cancelled', reason: 'User declined' })
    ).rejects.toMatchObject({ name: 'DepositApprovalRequiredError' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(token).not.toHaveBeenCalled()
    expect(provider.execute).not.toHaveBeenCalled()

    await expect(
      owner.execute(preview, { outcome: 'approved', previewChecksum: preview.previewChecksum })
    ).resolves.toMatchObject({
      versionDoi: '10.5072/zenodo.700',
      conceptDoi: '10.5072/zenodo.699'
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(token).toHaveBeenCalledWith({ provider: 'zenodo', environment: 'sandbox' })
    expect(provider.execute).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a real provider token is missing', async () => {
    const provider = fakeProvider()
    const owner = createArtifactDepositOwner({
      sourceReader: { read: vi.fn(async () => source()) },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: vi.fn(async () => undefined) },
      publicationStore: {
        findLatestForArtifact: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        findByVersion: vi.fn(async () => undefined)
      }
    })
    const preview = await owner.prepare({
      artifact: {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      provider: 'zenodo'
    })
    await expect(
      owner.execute(preview, { outcome: 'approved', previewChecksum: preview.previewChecksum })
    ).rejects.toMatchObject({ name: 'DepositCredentialMissingError' })
    expect(provider.execute).not.toHaveBeenCalled()
  })

  it('fails closed for an unknown artifact without reading credentials or making HTTP calls', async () => {
    const provider = fakeProvider()
    const token = vi.fn(async () => 'secret-token')
    const owner = createArtifactDepositOwner({
      sourceReader: { read: vi.fn(async () => undefined) },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: token },
      publicationStore: {
        findLatestForArtifact: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        findByVersion: vi.fn(async () => undefined)
      }
    })
    await expect(
      owner.prepare({
        artifact: {
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'missing'
        },
        provider: 'zenodo'
      })
    ).rejects.toMatchObject({ name: 'ArtifactDepositSourceNotFoundError' })
    expect(token).not.toHaveBeenCalled()
    expect(provider.execute).not.toHaveBeenCalled()
  })

  it('fails closed when the crate changes after preview', async () => {
    const provider = fakeProvider()
    const read = vi
      .fn<() => Promise<ArtifactDepositSource>>()
      .mockResolvedValueOnce(source())
      .mockResolvedValueOnce(
        source({
          crate: {
            filename: 'report.csv.ro-crate.zip',
            checksum: 'c'.repeat(64),
            sizeBytes: 2048,
            bytes: new Uint8Array([4, 5, 6])
          }
        })
      )
    const token = vi.fn(async () => 'secret-token')
    const owner = createArtifactDepositOwner({
      sourceReader: { read },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: token },
      publicationStore: {
        findLatestForArtifact: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        findByVersion: vi.fn(async () => undefined)
      }
    })
    const preview = await owner.prepare({
      artifact: {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      provider: 'zenodo'
    })
    await expect(
      owner.execute(preview, { outcome: 'approved', previewChecksum: preview.previewChecksum })
    ).rejects.toMatchObject({ name: 'DepositPreviewStaleError' })
    expect(token).not.toHaveBeenCalled()
    expect(provider.execute).not.toHaveBeenCalled()
  })

  it('writes the DOI to the exact artifact version and reuses the concept DOI for the next version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-deposit-'))
    temporaryDirectories.push(directory)
    const store = createFileArtifactPublicationStore({ root: directory })
    const provider = fakeProvider()
    const owner = createArtifactDepositOwner({
      sourceReader: { read: vi.fn(async () => source()) },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: vi.fn(async () => 'secret-token') },
      publicationStore: store,
      now: () => new Date('2026-10-01T00:00:00.000Z')
    })
    const request = {
      artifact: {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      provider: 'zenodo' as const
    }
    const firstPreview = await owner.prepare(request)
    const first = await owner.execute(firstPreview, {
      outcome: 'approved',
      previewChecksum: firstPreview.previewChecksum
    })
    expect(first.artifact.versionId).toBe('version-1')
    expect(await store.findByVersion('version-1')).toMatchObject({
      versionDoi: '10.5072/zenodo.700',
      artifact: { versionId: 'version-1', versionNumber: 1 }
    })

    const secondSource = source({
      artifact: { ...source().artifact, versionId: 'version-2', versionNumber: 2 }
    })
    const secondOwner = createArtifactDepositOwner({
      sourceReader: { read: vi.fn(async () => secondSource) },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: vi.fn(async () => 'secret-token') },
      publicationStore: store,
      now: () => new Date('2026-10-02T00:00:00.000Z')
    })
    const secondPreview = await secondOwner.prepare({
      ...request,
      artifact: { ...request.artifact, versionId: 'version-2' }
    })
    expect(secondPreview.lineage).toEqual({
      providerRecordId: '700',
      providerConceptRecordId: '699',
      conceptDoi: '10.5072/zenodo.699'
    })

    const persisted = JSON.parse(
      await readFile(
        join(directory, 'artifact-publications', 'project-1', 'artifact-1', 'version-1.json'),
        'utf8'
      )
    )
    expect(persisted.artifact.versionId).toBe('version-1')
    expect(persisted.conceptDoi).toBe('10.5072/zenodo.699')
  })

  it('does not write back after an unknown outcome and can reconcile it later', async () => {
    const provider = fakeProvider()
    vi.mocked(provider.reconcile).mockResolvedValueOnce({
      state: 'published',
      publication: {
        providerRecordId: '700',
        providerConceptRecordId: '699',
        conceptDoi: '10.5072/zenodo.699',
        versionDoi: '10.5072/zenodo.700'
      }
    })
    const save = vi.fn(async () => undefined)
    const owner = createArtifactDepositOwner({
      sourceReader: { read: vi.fn(async () => source()) },
      providers: { zenodo: provider, osf: provider },
      credentials: { getAccessToken: vi.fn(async () => 'secret-token') },
      publicationStore: {
        findLatestForArtifact: vi.fn(async () => undefined),
        save,
        findByVersion: vi.fn(async () => undefined)
      }
    })
    const preview = await owner.prepare({
      artifact: {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      provider: 'zenodo'
    })
    const unknown = new DepositOutcomeUnknownError({
      provider: 'zenodo',
      environment: 'sandbox',
      operation: 'create-draft',
      previewChecksum: preview.previewChecksum
    })
    vi.mocked(provider.execute).mockRejectedValueOnce(unknown)
    await expect(
      owner.execute(preview, { outcome: 'approved', previewChecksum: preview.previewChecksum })
    ).rejects.toBe(unknown)
    expect(save).not.toHaveBeenCalled()

    await expect(owner.reconcile(preview, unknown.reconciliation)).resolves.toMatchObject({
      state: 'published',
      publication: { versionDoi: '10.5072/zenodo.700' }
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ versionId: 'version-1' }),
        versionDoi: '10.5072/zenodo.700'
      })
    )
  })
})
