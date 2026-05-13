// Platform-level configuration
// Set these via environment variables or a .env file

export const PLATFORM_CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  GROQ_CODE_MODEL: process.env.GROQ_CODE_MODEL || 'moonshotai/kimi-k2-instruct-0905',
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || '',
};

