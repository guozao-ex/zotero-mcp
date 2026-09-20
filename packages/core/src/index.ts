/**
 * @zotero-mcp/core 的公开入口。
 *
 * 只暴露契约层与通道客户端；能力层（Items / Collections / …）与 Router + Policy
 * 在 M1 起的 change 中逐步加入。
 */

export {
  ZOTERO_ERROR_CODES,
  ERROR_STRATEGIES,
  LOCAL_API_SETTINGS_HINT,
  ZoteroChannelError,
  classifyStatus,
  classifyFetchError,
  describeError,
} from './errors.ts';
export type { ZoteroErrorCode, ZoteroErrorStrategy, ZoteroErrorDescriptor } from './errors.ts';

export {
  DEFAULT_LOCAL_API_BASE,
  DEFAULT_CACHE_DIRNAME,
  DEFAULT_AUDIT_DIRNAME,
  isLoopbackUrl,
  assertLoopbackUrl,
  toPosixPath,
  resolveCacheDir,
  resolveAuditDir,
  resolveBaseUrl,
  resolveTimeoutMs,
  serverCachePath,
} from './paths.ts';

export {
  UNKNOWN_HEADER_VALUE,
  ZOTERO_HEADER_NAMES,
  zoteroHeadersSchema,
  zoteroErrorCodeSchema,
  probeResultSchema,
  readZoteroHeaders,
  JSON_SCHEMA_EXPORTS,
  exportJsonSchemas,
} from './schema.ts';
export type { ZoteroHeaders, ProbeResult, JsonSchemaExportName } from './schema.ts';

export {
  DEFAULT_TRANSLATION_SERVER_URL,
  DEFAULT_TRANSLATION_TIMEOUT_MS,
  TRANSLATION_TOKEN_HEADER,
  REDACTED_TOKEN,
  TranslationServerError,
  redactTranslationToken,
  resolveTranslationServerUrl,
  resolveTranslationToken,
  resolveTranslationTimeoutMs,
  requestTranslationItems,
  probeTranslationServer,
} from './channels/translation-server.ts';
export type {
  TranslationErrorKind,
  TranslationChannelError,
  TranslationServerOptions,
  TranslationRequestOptions,
  TranslationProbeResult,
} from './channels/translation-server.ts';

export {
  PROBE_PATH,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeLocalApi,
  requestLocalApi,
  fileUrlToPath,
  resolveItemFilePath,
  requestLocalText,
} from './channels/local-api.ts';
export type { ProbeOptions, LocalApiRequestOptions, LocalApiResponse } from './channels/local-api.ts';

export {
  MAX_BATCH_KEYS,
  LIBRARY_PREFIX,
  chunk,
  annotationDeepLink,
  toAnnotationDetail,
  creatorsOf,
  toItemSummary,
  getItems,
  readContent,
  getFulltextIndex,
  fetchChildren,
  fetchAnnotationChildren,
  countAnnotations,
} from './capabilities/read.ts';
export type {
  IncludeFlag,
  ChannelOptions,
  ItemEnvelope,
  ItemSummary,
  ItemDetail,
  AnnotationDetail,
  NoteDetail,
  AttachmentDetail,
  GetItemsOptions,
  ReadContentOptions,
  ContentResult,
} from './capabilities/read.ts';

export {
  DEFAULT_SEARCH_LIMIT,
  searchItems,
  listCollections,
  listTags,
} from './capabilities/search.ts';
export type {
  SearchMode,
  SearchOptions,
  SearchResult,
  CollectionNode,
  CollectionsResult,
  TagSummary,
} from './capabilities/search.ts';

export {
  PAGE_SIZE,
  normalizeStrongKey,
  fetchAllTopItems,
  fetchAllAttachments,
  libraryStats,
  findDuplicateCandidates,
  findDuplicateReport,
} from './capabilities/insights.ts';
export type {
  LibraryStats,
  DuplicateCandidate,
  DuplicateCluster,
  DuplicateReport,
} from './capabilities/insights.ts';

export {
  TITLE_MATCH_THRESHOLD,
  HEAD_WINDOW_BYTES,
  TAIL_WINDOW_BYTES,
  NEEDS_METADATA_TAG,
  titleFromFileName,
  extractIdentifier,
  parseXmp,
  parsePdfInfo,
  normalizePdfDate,
  parseCreatorName,
  recordFromPdfMetadata,
  pickBestByTitle,
  isUsableTitle,
  identifyPdf,
  identifiedFields,
} from './capabilities/pdf-identification.ts';
export type {
  IdentificationLevel,
  IdentificationHit,
  PdfIdentificationResult,
  IdentificationIO,
  IdentifyPdfOptions,
} from './capabilities/pdf-identification.ts';

export {
  MERGE_CONFIRM_KEYWORD,
  RECOGNIZE_CONFIRM_KEYWORD,
  MERGE_ENDPOINT,
  RECOGNIZE_ENDPOINT,
  normalizeMergeKeys,
  isRecognizablePdf,
  buildMergePlan,
  applyMerge,
  buildRecognizePlan,
  applyRecognize,
  pluginTokenFile,
} from './capabilities/merge-duplicates.ts';
export type {
  MergeOptions,
  MergeItemSnapshot,
  MergePlan,
  MergeApplyOptions,
  MergeApplyResult,
  RecognizeOptions,
  RecognizePlan,
  RecognizeApplyOptions,
  RecognizeApplyResult,
} from './capabilities/merge-duplicates.ts';

export {
  PLUGIN_ENDPOINTS,
  PLUGIN_TOKEN_FILENAME,
  PLUGIN_TOKEN_HEADER,
  PLUGIN_CLIENT_MODES,
  PLUGIN_HINTS,
  resolveDataDir,
  pluginTokenPath,
  readPluginToken,
  revealDeepLink,
  pluginHealth,
  pluginSync,
  pluginSelectItems,
  requestPluginAnnotations,
} from './capabilities/client-channel.ts';
export type {
  PluginEndpoint,
  PluginClientMode,
  PluginUnavailableReason,
  PluginUnavailable,
  PluginAvailable,
  PluginStatus,
  RevealDeepLinkOptions,
  PluginCallOptions,
  PluginHealthResult,
  PluginSyncResult,
  PluginSelectResult,
  PluginAnnotationSpec,
  PluginAnnotationsResult,
} from './capabilities/client-channel.ts';

export {
  DEFAULT_WEB_API_BASE,
  WEB_API_CREDENTIALS_FILENAME,
  WEB_API_KEY_ENV,
  WEB_API_LIBRARY_ENV,
  webApiCredentialsPath,
  webApiSetupHint,
  maskApiKey,
  resolveWebApiConfig,
} from './capabilities/channel-config.ts';
export type {
  WebApiConfig,
  WebApiConfigured,
  WebApiNotConfigured,
  WebApiConfigOptions,
  WebApiLibrary,
} from './capabilities/channel-config.ts';

export {
  ANNOTATION_WRITE_CONFIRM_KEYWORD,
  MAX_ANNOTATIONS,
  LOCAL_LIBRARY_PREFIX,
  planAnnotationWrite,
  applyAnnotationWrite,
  probeLocalWriteChannel,
  probeChannels,
  summarizeWebApiConfig,
} from './capabilities/write-channel.ts';
export type {
  WriteChannelId,
  ChannelAvailability,
  ChannelProbeSummary,
  AnnotationPlanItem,
  AnnotationWritePlan,
  AnnotationWriteResult,
  AnnotationWriteResultItem,
  AnnotationWriteOptions,
  ApplyAnnotationWriteOptions,
  PlanAnnotationWriteInput,
  LocalApiProbe,
} from './capabilities/write-channel.ts';

export {
  ENRICH_SOURCES,
  ENRICH_MODES,
  RETRACTION_SOURCES,
  DOI_TITLE_THRESHOLD,
  DEFAULT_ENRICH_MIN_INTERVAL_MS,
  DEFAULT_ENRICH_S2_MIN_INTERVAL_MS,
  DEFAULT_ENRICH_TIMEOUT_MS,
  DEFAULT_ENRICH_CACHE_TTL_MS,
  DEFAULT_ENRICH_MAILTO,
  ENRICH_CACHE_DIRNAME,
  RETRACTED_TAG,
  OPEN_ACCESS_TAG,
  NEEDS_ENRICHMENT_TAG,
  ENRICHMENT_BLOCK_START,
  ENRICHMENT_BLOCK_END,
  OA_CASCADE,
  resolveEnrichMailto,
  enrichUserAgent,
  resolveEnrichMinIntervalMs,
  resolveEnrichS2MinIntervalMs,
  resolveEnrichTimeoutMs,
  resolveEnrichCacheTtlMs,
  stripDoi,
  sameDoi,
  normalizePmcId,
  pmcArticleUrl,
  decodeXmlEntities,
  mapOpenAlexWork,
  mapSemanticScholarPaper,
  mapCrossrefEnrichment,
  mapUnpaywallRecord,
  mapPubmedEsummary,
  parseArxivFeed,
  mapArxivEntry,
  mergeIntel,
  enrichmentBlockLines,
  renderEnrichmentBlock,
  extractEnrichmentBlock,
  applyEnrichmentBlock,
  enrichCachePath,
  pickDoiByTitle,
  enrichmentWriteSet,
  enrichItems,
  buildEnrichmentPlan,
} from './capabilities/enrichment.ts';
export type {
  EnrichSource,
  EnrichMode,
  OaCascadeSource,
  SourceIntel,
  ArxivEntry,
  EnrichmentIntel,
  EnrichmentBlockInfo,
  EnrichIO,
  EnrichIOOverrides,
  EnrichmentCall,
  SourceAttemptStatus,
  SourceAttempt,
  EnrichExisting,
  EnrichmentWriteSet,
  EnrichDoiFallback,
  EnrichmentItemResult,
  EnrichOptions,
  EnrichmentReport,
  BuildEnrichmentPlanOptions,
} from './capabilities/enrichment.ts';

export {
  DEFAULT_TITLE_THRESHOLD,
  DEFAULT_YEAR_TOLERANCE,
  DEFAULT_AUTHOR_THRESHOLD,  firstStrongKey,
  normalizeTitle,
  firstAuthorSurname,
  parseYear,
  jaroWinkler,
  toDedupeCandidate,
  pickPrimary,
  weakKeyMatch,
  clusterItems,
  explainRejectedPairs,
  evaluateClustering,
} from './capabilities/dedupe.ts';
export type {
  StrongKeyType,
  ClusterMatchType,
  DedupeCandidate,
  DedupeCluster,
  DedupeOptions,
  WeakMatchResult,
  DedupeLabels,
  DedupeMetrics,
  RejectedPair,
} from './capabilities/dedupe.ts';

export {
  EXPORT_FORMATS,
  buildExportPath,
  extractCitationKey,
  validateBib,
  countBibLikeEntries,
  exportItems,
} from './capabilities/citations.ts';
export type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  BibValidation,
  BibValidationIssue,
  BibValidationOptions,
} from './capabilities/citations.ts';

export {
  BIBLIOGRAPHY_PLACEHOLDER,
  CITATION_SCHEMA_URL,
  DEFAULT_CITATION_LOCALE,
  DEFAULT_CITATION_STYLE,
  URI_USER_SEGMENT,
  buildBibliographyCode,
  buildCitationCode,
  citationUri,
  compileBibSample,
  detectLatexEnvironmentIssue,
  detectWord,
  fetchCitationData,
  findPlaceholders,
  htmlToPlainText,
  injectCitations,
  injectFields,
  joinCitationTexts,
  normalizeMapping,
  resolveLatex,
  resolvePlaceholder,
  scanParagraphRuns,
} from './capabilities/citation-writing.ts';
export {
  LABEL_BACKFILL_CONFIRM,
  applyAnnotationLabelBackfill,
  planAnnotationLabelBackfill,
} from './capabilities/annotation-labels.ts';
export type {
  AnnotationLabelBackfillOptions,
  AnnotationLabelBackfillPlan,
  AnnotationLabelPair,
} from './capabilities/annotation-labels.ts';
export {
  CITAVI_QUOTATION_TYPES,
  buildCitaviAnnotationExchange,
  toCitaviQuads,
  toQuotationType,
} from './capabilities/highlight-exchange.ts';
export type {
  CitaviExchangeEntry,
  CitaviExchangeOptions,
  CitaviExchangeResult,
  CitaviExchangeSkipped,
  CitaviQuad,
} from './capabilities/highlight-exchange.ts';
export type {
  BibCompileResult,
  CitationMappingEntry,
  CitationMappingInput,
  CitationMappingValue,
  InjectCitationsOptions,
  InjectCitationsResult,
  InjectionField,
  InjectionOutcome,
  InjectionRequest,
  LatexEnvironment,
  PlaceholderHit,
} from './capabilities/citation-writing.ts';

export {
  buildRollbackPlan,
  parseRollbackArgs,
  readSnapshotFile,
  renderRollbackPlan,
  validateSnapshot,
} from './capabilities/rollback-cli.ts';
export type {
  RollbackArgs,
  RollbackFieldChange,
  RollbackPlan,
  RollbackSnapshot,
  SnapshotValidation,
} from './capabilities/rollback-cli.ts';

export {
  DOCUMENT_PART,
  MAX_ENTRY_BYTES,
  buildMinimalDocx,
  createZip,
  crc32,
  escapeXmlText,
  readZip,
  replaceEntry,
  writeZip,
} from './capabilities/docx-zip.ts';
export type { ZipArchive, ZipEntry } from './capabilities/docx-zip.ts';

export {
  DEFAULT_AUDIT_DIR,
  MAX_WRITE_BATCH,
  OVERWRITE_KEYWORD,
  DELETE_KEYWORD,
  AUTHORIZE_PATH,
  assertWriteEnabled,
  isWriteEnabled,
  buildChangePlan,
  makeChangePlan,
  previewPlan,
  applyPlan,
  resolveCreatedRefs,
  rollbackFromSnapshot,
  readItemEnvelope,
  readTrashKeySet,
  resetLocalApiAuthCache,
} from './capabilities/write-pipeline.ts';
export type {
  FieldChange,
  ChangePlan,
  PlanOperation,
  ApplyResult,
  ApplyOptions,
  UpdateIntent,
} from './capabilities/write-pipeline.ts';

export {
  WRITE_TOOL_NAMES,
  COLLECTION_ACTIONS,
  TAG_ACTIONS,
  DEFAULT_TRANSLATION_SERVER,
  DEFAULT_CROSSREF_MAILTO,
  contentTypeForPath,
  normalizeNoteHtml,
  buildCreateItemPlan,
  buildUpdateItemPlan,
  buildDeleteItemsPlan,
  buildManageCollectionsPlan,
  buildManageTagsPlan,
  buildAttachFilePlan,
  buildAddNotePlan,
  collectTargetAnnotations,
  renderAnnotationsNote,
  detectIdentifierKind,
  normalizeIdentifier,
  mapCrossrefWork,
  mapOpenLibraryBook,
  mapPubmedSummary,
  resolveIdentifier,
  buildAddItemsPlan,
} from './capabilities/write-tools.ts';
export type {
  CreatorInput,
  CreateItemOptions,
  UpdateItemOptions,
  DeleteItemsOptions,
  CollectionAction,
  ManageCollectionsOptions,
  TagAction,
  ManageTagsOptions,
  AttachFileOptions,
  AttachFilePlanResult,
  AddNoteOptions,
  AddNotePlanResult,
  IdentifierKind,
  IdentifierSource,
  ResolvedRecord,
  IdentifierResolution,
  ResolveIdentifierOptions,
  AddItemsOptions,
  AddItemsPlanResult,
} from './capabilities/write-tools.ts';
