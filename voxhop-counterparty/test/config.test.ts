import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parses valid env with defaults applied', async () => {
        vi.stubEnv('PORT', '');
        vi.stubEnv('WHISPER_URL', '');
        vi.stubEnv('OLLAMA_URL', '');
        vi.stubEnv('PIPER_URL', '');

        // Reset to empty so defaults kick in
        const savedEnv = { ...process.env };
        delete process.env['PORT'];
        delete process.env['WHISPER_URL'];
        delete process.env['OLLAMA_URL'];
        delete process.env['PIPER_URL'];

        const { validateConfig } = await import('../src/config');
        const config = validateConfig();
        expect(config.PORT).toBe(3001);
        expect(config.WHISPER_URL).toBe('http://localhost:8001');
        expect(config.OLLAMA_URL).toBe('http://localhost:11434');
        expect(config.PIPER_URL).toBe('http://localhost:5000');
        expect(config.VAD_SILENCE_THRESHOLD_MS).toBe(600);

        Object.assign(process.env, savedEnv);
    });

    it('coerces PORT from string to number', async () => {
        const savedPort = process.env['PORT'];
        const savedWhisper = process.env['WHISPER_URL'];
        const savedOllama = process.env['OLLAMA_URL'];
        const savedPiper = process.env['PIPER_URL'];
        process.env['PORT'] = '8080';
        // Delete URL vars so Zod uses its defaults (empty-string from prior
        // test's vi.stubEnv restoration would fail z.string().url() otherwise)
        delete process.env['WHISPER_URL'];
        delete process.env['OLLAMA_URL'];
        delete process.env['PIPER_URL'];
        vi.resetModules();
        const { validateConfig } = await import('../src/config');
        const config = validateConfig();
        expect(config.PORT).toBe(8080);
        expect(typeof config.PORT).toBe('number');
        if (savedPort !== undefined) process.env['PORT'] = savedPort;
        else delete process.env['PORT'];
        if (savedWhisper !== undefined) process.env['WHISPER_URL'] = savedWhisper;
        else delete process.env['WHISPER_URL'];
        if (savedOllama !== undefined) process.env['OLLAMA_URL'] = savedOllama;
        else delete process.env['OLLAMA_URL'];
        if (savedPiper !== undefined) process.env['PIPER_URL'] = savedPiper;
        else delete process.env['PIPER_URL'];
    });

    it('calls process.exit(1) when VAD_SILENCE_THRESHOLD_MS is below 200', async () => {
        const savedVal = process.env['VAD_SILENCE_THRESHOLD_MS'];
        process.env['VAD_SILENCE_THRESHOLD_MS'] = '100';
        vi.resetModules();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
        const { validateConfig } = await import('../src/config');
        expect(() => validateConfig()).toThrow('process.exit called');
        expect(exitSpy).toHaveBeenCalledWith(1);
        if (savedVal !== undefined) process.env['VAD_SILENCE_THRESHOLD_MS'] = savedVal;
        else delete process.env['VAD_SILENCE_THRESHOLD_MS'];
    });
});
