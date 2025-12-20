import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
});

export const runtime = 'edge';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response('ok', { headers: corsHeaders });
}

export async function POST(req) {
  try {
    const { message, history } = await req.json();

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message.replace(/\n/g, ' '),
    });
    const embedding = embeddingResponse.data[0].embedding;

    const { data: chunks, error } = await supabase.rpc('tb_match_chunks', {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 8,
    });

    if (error) throw error;

    const distinctSources = Array.from(new Set(chunks.map(c => JSON.stringify({ title: c.title, url: c.url }))))
      .map(s => JSON.parse(s));
    
    const contextText = chunks.map(c => `SOURCE: ${c.title} (${c.url})\nCONTENT: ${c.content}`).join('\n\n---\n\n');

    const systemPrompt = `
    You are the "Travel by Brit" vacation planner assistant. 
    Use the following context snippets from the Travel by Brit blog to answer the user's question.
    
    Rules:
    - Only answer based on the provided context.
    - Be friendly, enthusiastic, and concise. 
    - Format your answer in Markdown.
    - Do NOT invent hotels or restaurants not mentioned in the text.
    
    Context:
    ${contextText}
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-4), 
        { role: 'user', content: message }
      ],
      temperature: 0.5,
    });

    const answer = completion.choices[0].message.content;

    return new Response(JSON.stringify({
      answer: answer,
      sources: distinctSources
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: corsHeaders });
  }
}