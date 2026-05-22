import { NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { AzureOpenAI } from 'openai';

const client = new AzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY || '',
  endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview',
});

const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4-nano';

const CHALLENGE_TYPES = [
  'continuous-movement',
  'raise-right-hand',
  'raise-both-hands',
  'punch-challenge',
] as const;

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // 1. Fetch transcript
    console.log(`Fetching transcript for: ${url}`);
    let transcriptItems;
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(url);
    } catch (e) {
      console.error('Transcript fetch failed:', e);
      return NextResponse.json({ error: 'Could not fetch transcript' }, { status: 500 });
    }

    if (!transcriptItems || transcriptItems.length === 0) {
      return NextResponse.json({ error: 'No transcript found for this video' }, { status: 404 });
    }

    // Combine transcript into a readable format for the LLM
    const MAX_ITEMS = 300;
    const transcriptText = transcriptItems
      .slice(0, MAX_ITEMS)
      .map(item => `[${(item.offset / 1000).toFixed(1)}s] ${item.text}`)
      .join('\n');

    // 2. Call Azure OpenAI
    const systemPrompt = `You are an AI game design agent for camera-native interactive demos.
You will be given a YouTube video transcript. Produce 2-3 reliable body interaction moments as a JSON array.

CRITICAL CONSTRAINTS:
1. You may ONLY choose challenge id from: "continuous-movement", "raise-right-hand", "raise-both-hands", "punch-challenge".
2. Prefer "punch-challenge" for transcript moments about punch, jab, strike, boxing, speed bag, or shadowboxing.
3. Prefer "continuous-movement" for sustained movement cues (dance, keep moving, run in place, etc).
4. triggerTimestamp must map to a real transcript beat and subtract ~1s for reaction time.
5. promptTimestamp should be 2.0-2.5 seconds before triggerTimestamp.
6. Write short instructions and include tactical reasoning fields so UI can narrate the agent decision.

Respond with ONLY a JSON array of objects. Each object must have these fields:
- id: one of ${CHALLENGE_TYPES.join(', ')}
- triggerTimestamp: float seconds
- instruction: short playable challenge instruction
- promptTimestamp: float seconds
- promptText: short teacher prompt overlay text
- rationale: brief explanation of why this moment was chosen
- selectedPrimitive: primitive name like punch-speed, both-hands, movement-loop
- inputSignal: what the model tracks in camera input
- winCondition: how player succeeds
- difficulty: easy, medium, or hard
- viralMoment: how this moment looks shareable

Respond with ONLY the JSON array, no markdown fences, no explanation.`;

    console.log('Calling Azure OpenAI...');

    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this transcript and produce the JSON array:\n\n${transcriptText}` },
      ],
      temperature: 0.2,
      max_completion_tokens: 4096,
    });

    const responseText = response.choices[0]?.message?.content || '';

    let parsedJSON: unknown[];
    try {
      parsedJSON = JSON.parse(responseText);
    } catch {
      // Try to extract JSON array from response
      const start = responseText.indexOf('[');
      const end = responseText.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        parsedJSON = JSON.parse(responseText.slice(start, end + 1));
      } else {
        throw new Error('Failed to extract JSON array from LLM response');
      }
    }

    return NextResponse.json({ challenges: parsedJSON });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('API Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
