import { NextResponse } from 'next/server';
import { AzureOpenAI } from 'openai';
import { GameConfig } from '../../../lib/schema';

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

    console.log(`Generating game config for prompt: ${prompt}`);

    const systemPrompt = `You are the Motions Platform Game Engine Compiler.
Your job is to take a user's plain-English description of a camera-based game and map it EXACTLY to a JSON GameConfig object.

You have access to these specific CV Primitives:
- 'squat'
- 'lateral-dodge'
- 'jump'
- 'punch'
- 'both-hands-raise'

You have access to these core Mechanics:
- 'count-reps' (Do it as many times as possible within the duration)
- 'survival-dodge' (Dodge obstacles, stay alive)
- 'strike-targets' (Hit or punch falling objects to destroy them)
- 'pose-match' (Hold a specific pose)

CRITICAL RULES:
1. Respond with ONLY valid JSON. No markdown, no fences.
2. Ensure the JSON exactly matches this schema:
{
  "title": "String - A catchy 1-3 word title",
  "mechanic": "String - Must be one of the Mechanics listed above",
  "primitive": "String - Must be one of the CV Primitives listed above",
  "duration": "Number - Duration in seconds (e.g. 20, 30, 60)",
  "instructions": "String - A very short 1-line instruction like 'Do as many squats as you can in 30 seconds!'",
  "threatEmoji": "String - (Optional) A single emoji representing the obstacle or theme. e.g., '☄️', '🍕', '👾', '🧟'",
  "themeColor": "String - (Optional) A hex color code matching the theme. e.g., '#ff0000'"
}

Example Input: "A 20 second speed squat test"
Example Output:
{
  "title": "Squat Speed",
  "mechanic": "count-reps",
  "primitive": "squat",
  "duration": 20,
  "instructions": "Pump out as many squats as you can!",
  "threatEmoji": "🔥",
  "themeColor": "#ef4444"
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
    let parsedConfig: GameConfig;
    
    try {
      parsedConfig = JSON.parse(responseText);
    } catch (e) {
       console.error("Failed to parse LLM JSON:", responseText);
       throw new Error("Invalid JSON from LLM");
    }

    // Default duration safeguard
    if (!parsedConfig.duration || isNaN(parsedConfig.duration)) {
        parsedConfig.duration = 20;
    }

    return NextResponse.json({ config: parsedConfig });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('API Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
