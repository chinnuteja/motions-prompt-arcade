import { NextResponse } from 'next/server';
import { AzureOpenAI } from 'openai';
import { EffectConfig, validateEffectConfig, DEFAULT_EFFECT_CONFIG } from '../../../lib/vfx-schema';

const client = new AzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY || '',
  endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview',
});

const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4-nano';

export async function POST(req: Request) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    console.log(`Generating VFX config for prompt: ${prompt}`);

    const systemPrompt = `You are the Motions Hand VFX Compiler.
Your job is to take a user's plain-English description of a visual effect and map it EXACTLY to a JSON EffectConfig object.

You have access to these specific Effects:
- 'aura_blaster': Charge massive glowing energy spheres in your fists, open hands to blast plasma beams.
  -> params: beamStyle ("laser"|"plasma"|"electric"), chargeEffect ("implosion"|"vortex")
- 'particle_nebula': Particles orbit your palm, explode when you open your hand.
  -> params: motion ("orbit"|"stream"|"swarm"), openHandAction ("explode"|"release"), trail ("short"|"long")
- 'glitch_tiles': Point to warp the camera feed into glitchy tiles, pinch to grab and throw them.
  -> params: tileShape ("square"|"wide"|"shard"), pullMode ("attract"|"repel"|"vortex"|"fan"), snapBack ("spring"|"drift")
- 'fire_magic': Real fluid fire on your hands. Fist condenses and charges it, open hand erupts.
  -> params: eruption ("burst"|"flamethrower"), form ("wildfire"|"plasma"), trails ("smoky"|"clean")

You have access to these Palettes:
- 'neon': Cyan and magenta
- 'ember': Orange and red fire
- 'vapor': Pink and purple vaporwave
- 'mono': High-contrast black and white
- 'acid': Toxic green and yellow
- 'ocean': Deep blues and aqua

CRITICAL RULES:
1. Respond with ONLY valid JSON. No markdown, no fences.
2. Ensure the JSON exactly matches the parameters for the chosen effect.
3. 'intensity' must be exactly 1 (low), 2 (medium), or 3 (high).
4. 'v' must be exactly 1.
5. If the user asks for fire/flames WITHOUT explicitly specifying a color, ALWAYS use the 'ember' (orange) palette.

JSON SCHEMA EXAMPLES:

User: "Let me fire huge electric beams from my hands"
{
  "v": 1,
  "effect": "aura_blaster",
  "palette": "neon",
  "intensity": 3,
  "prompt": "Let me fire huge electric beams from my hands",
  "params": {
    "beamStyle": "electric",
    "chargeEffect": "implosion"
  }
}

User: "Shatter reality into a black and white mirror"
{
  "v": 1,
  "effect": "glitch_tiles",
  "palette": "mono",
  "intensity": 3,
  "prompt": "Shatter reality into a black and white mirror",
  "params": {
    "tileShape": "shard",
    "pullMode": "vortex",
    "snapBack": "drift"
  }
}

User: "Neon galaxy that explodes when I open my hand"
{
  "v": 1,
  "effect": "particle_nebula",
  "palette": "neon",
  "intensity": 3,
  "prompt": "Neon galaxy that explodes when I open my hand",
  "params": {
    "motion": "orbit",
    "openHandAction": "explode",
    "trail": "long"
  }
}

User: "Give me a huge flamethrower"
{
  "v": 1,
  "effect": "fire_magic",
  "palette": "ember",
  "intensity": 3,
  "prompt": "Give me a huge flamethrower",
  "params": {
    "eruption": "flamethrower",
    "form": "plasma",
    "trails": "clean"
  }
}`;

    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 1024,
      response_format: { type: 'json_object' }
    });

    const responseText = response.choices[0]?.message?.content || '{}';
    let parsed: unknown;
    
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse LLM JSON:", responseText);
      return NextResponse.json({ config: DEFAULT_EFFECT_CONFIG });
    }

    // Strict Zod validation
    const config = validateEffectConfig(parsed);
    
    if (!config) {
      console.warn("LLM output failed Zod validation. Falling back to default.", parsed);
      return NextResponse.json({ config: DEFAULT_EFFECT_CONFIG });
    }

    return NextResponse.json({ config });

  } catch (error: unknown) {
    console.error('API Error:', error);
    // On API failure, return default instead of breaking the flow
    return NextResponse.json({ config: DEFAULT_EFFECT_CONFIG });
  }
}
