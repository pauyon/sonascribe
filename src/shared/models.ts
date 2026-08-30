/**
 * Catalogue of speech-recognition models the app offers.
 *
 * Shared between processes: the renderer renders the picker from this list and
 * the main process resolves downloads from it, so there is one definition of
 * what "small.en" means.
 */

/** Which recognition engine runs a model. */
export type AsrEngine = 'whisper' | 'parakeet'

/**
 * Every engine whose models this catalogue tracks — the two ASR engines plus
 * `'llama'` for the offline Q&A answering model. Kept distinct from
 * `AsrEngine`: transcription routing (`transcription-pipeline.ts`'s
 * `runAsr()`) only ever needs to know about the two real ASR engines, and
 * widening `AsrEngine` itself would let a non-ASR model slip in there.
 */
export type ModelEngine = AsrEngine | 'llama'

export interface EngineSpec {
  id: ModelEngine
  label: string
  blurb: string
}

export const ENGINES: EngineSpec[] = [
  {
    id: 'whisper',
    label: 'Whisper',
    blurb:
      'OpenAI Whisper via whisper.cpp. Widest language coverage, and the only engine here that takes a language hint.'
  },
  {
    id: 'parakeet',
    label: 'Parakeet',
    blurb:
      'NVIDIA Parakeet TDT. Faster than Whisper at comparable size, with notably better punctuation. Auto-detects language; the language setting does not apply.'
  },
  {
    id: 'llama',
    label: 'Answering',
    blurb:
      'Generates answers to questions asked about a transcript, grounded in its actual content. Unlike the ASR engines above, there is nothing to select — download it once and it is simply used.'
  }
]

export interface ModelSpec {
  id: string
  label: string
  engine: ModelEngine
  /** Hugging Face repository the weights come from. */
  repo: string
  /** File within that repository, and the name used on disk. */
  file: string
  /** Approximate on-disk size. Used for the picker and a post-download check. */
  sizeBytes: number
  /** Which magic bytes verify a completed download — ASR models are the older ggml format, the answering model is GGUF. */
  format: 'ggml' | 'gguf'
  /** 1 (slowest) to 5 (fastest) — relative, for the picker only. Not meaningful for the answering model. */
  speed?: number
  /** 1 (roughest) to 5 (best) — relative, for the picker only. Not meaningful for the answering model. */
  accuracy?: number
  languages?: 'english' | 'multilingual'
  note: string
}

const WHISPER_REPO = 'ggerganov/whisper.cpp'
const PARAKEET_REPO = 'ggml-org/parakeet-GGUF'
const QWEN_REPO = 'Qwen/Qwen2.5-3B-Instruct-GGUF'

export const MODELS: ModelSpec[] = [
  {
    id: 'tiny.en',
    label: 'Whisper Tiny (English)',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-tiny.en.bin',
    sizeBytes: 77_704_715,
    format: 'ggml',
    speed: 5,
    accuracy: 1,
    languages: 'english',
    note: 'Fastest. Good for testing or rough notes, not for a transcript you will rely on.'
  },
  {
    id: 'base.en',
    label: 'Whisper Base (English)',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-base.en.bin',
    sizeBytes: 147_951_465,
    format: 'ggml',
    speed: 4,
    accuracy: 2,
    languages: 'english',
    note: 'Usable for clear single-speaker audio.'
  },
  {
    id: 'small.en',
    label: 'Whisper Small (English)',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-small.en.bin',
    sizeBytes: 487_601_967,
    format: 'ggml',
    speed: 3,
    accuracy: 3,
    languages: 'english',
    note: 'A solid middle ground on a machine without much CPU headroom.'
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Whisper Large v3 Turbo (compressed)',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    format: 'ggml',
    speed: 2,
    accuracy: 4,
    languages: 'multilingual',
    note: 'Quantized Turbo. Close to full Turbo accuracy at a third of the size.'
  },
  {
    id: 'large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-large-v3-turbo.bin',
    sizeBytes: 1_624_555_275,
    format: 'ggml',
    speed: 2,
    accuracy: 5,
    languages: 'multilingual',
    note: 'Near large-v3 quality at roughly eight times the speed. The best Whisper option here.'
  },

  {
    id: 'parakeet-tdt-0.6b-v3-q4_0',
    label: 'Parakeet TDT 0.6B (compressed)',
    engine: 'parakeet',
    repo: PARAKEET_REPO,
    file: 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
    sizeBytes: 355_615_679,
    format: 'ggml',
    speed: 5,
    accuracy: 4,
    languages: 'multilingual',
    note: 'Very fast and punctuates well for its size. A strong default if you are not sure.'
  },
  {
    id: 'parakeet-tdt-0.6b-v3-q8_0',
    label: 'Parakeet TDT 0.6B',
    engine: 'parakeet',
    repo: PARAKEET_REPO,
    file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin',
    sizeBytes: 669_000_000,
    format: 'ggml',
    speed: 4,
    accuracy: 5,
    languages: 'multilingual',
    note: 'Less aggressively quantized. Best accuracy-per-second on the list.'
  },

  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    label: 'Qwen2.5 3B Instruct',
    engine: 'llama',
    repo: QWEN_REPO,
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeBytes: 1_929_902_912,
    format: 'gguf',
    note: 'Answers questions about a transcript, grounded in its actual content. The largest single download here, chosen for noticeably better grounding than a smaller model.'
  }
]

export const DEFAULT_MODEL_ID = 'parakeet-tdt-0.6b-v3-q4_0'

/** The one model `services/answering.ts` loads — there is no picker for it, unlike transcription. */
export const DEFAULT_CHAT_MODEL_ID = 'qwen2.5-3b-instruct-q4_k_m'

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
}

/**
 * Same lookup, narrowed to an actual transcription engine.
 *
 * Transcription routing has no use for the answering model — this also
 * catches the case where a stored `modelId` somehow names it, reporting
 * "unknown model" rather than letting an ASR-only code path see `engine:
 * 'llama'`.
 */
export function findAsrModel(id: string): (ModelSpec & { engine: AsrEngine }) | undefined {
  const spec = findModel(id)
  return spec && spec.engine !== 'llama' ? (spec as ModelSpec & { engine: AsrEngine }) : undefined
}

export function modelDownloadUrl(spec: ModelSpec): string {
  return `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}?download=true`
}

export function modelFileName(spec: ModelSpec): string {
  return spec.file
}

/** Runtime state of a model on this machine. */
export interface ModelStatus {
  id: string
  installed: boolean
  /** Bytes already on disk, including a partial download. */
  bytesOnDisk: number
  downloading: boolean
  /** 0..1 while downloading. */
  fraction: number | null
  error: string | null
}

export interface ModelDownloadProgress {
  modelId: string
  receivedBytes: number
  totalBytes: number | null
  fraction: number | null
  done: boolean
  error: string | null
}
