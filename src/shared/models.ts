/**
 * Catalogue of speech-recognition models the app offers.
 *
 * Shared between processes: the renderer renders the picker from this list and
 * the main process resolves downloads from it, so there is one definition of
 * what "small.en" means.
 */

/** Which recognition engine runs a model. */
export type AsrEngine = 'whisper' | 'parakeet'

export interface EngineSpec {
  id: AsrEngine
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
  }
]

export interface ModelSpec {
  id: string
  label: string
  engine: AsrEngine
  /** Hugging Face repository the weights come from. */
  repo: string
  /** File within that repository, and the name used on disk. */
  file: string
  /** Approximate on-disk size. Used for the picker and a post-download check. */
  sizeBytes: number
  /** 1 (slowest) to 5 (fastest) — relative, for the picker only. */
  speed: number
  /** 1 (roughest) to 5 (best) — relative, for the picker only. */
  accuracy: number
  languages: 'english' | 'multilingual'
  note: string
}

const WHISPER_REPO = 'ggerganov/whisper.cpp'
const PARAKEET_REPO = 'ggml-org/parakeet-GGUF'

export const MODELS: ModelSpec[] = [
  {
    id: 'tiny.en',
    label: 'Whisper Tiny (English)',
    engine: 'whisper',
    repo: WHISPER_REPO,
    file: 'ggml-tiny.en.bin',
    sizeBytes: 77_704_715,
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
    speed: 4,
    accuracy: 5,
    languages: 'multilingual',
    note: 'Less aggressively quantized. Best accuracy-per-second on the list.'
  }
]

export const DEFAULT_MODEL_ID = 'parakeet-tdt-0.6b-v3-q4_0'

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
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
