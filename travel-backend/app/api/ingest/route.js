import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';

export const maxDuration = 60;

const INGEST_SECRET = process.env.INGEST_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.LLM_API_KEY });

function chunkText(text, maxLength = 1000) {
  const chunks = [];
  let currentChunk = "";
  const sentences = text.split(/(?<=[.?!])\s+/);

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      chunks.push(currentChunk);
      currentChunk = "";
    }
    currentChunk += sentence + " ";
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');

  if (secret !== INGEST_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const wpRes = await fetch(`${process.env.WP_BASE_URL}/wp-json/wp/v2/posts?per_page=5&_fields=id,link,title,content`);
  const posts = await wpRes.json();
  
  let totalChunks = 0;

  for (const post of posts) {
    await supabase.from('tb_chunks').delete().eq('post_id', post.id);

    const $ = cheerio.load(post.content.rendered);
    const title = post.title.rendered;
    const url = post.link;
    
    $('script').remove();
    $('style').remove();
    const cleanText = $('body').text().replace(/\s+/g, ' ').trim();

    const textChunks = chunkText(cleanText, 1500); 

    for (const chunkContent of textChunks) {
       const embeddingRes = await openai.embeddings.create({
         model: 'text-embedding-3-small',
         input: chunkContent
       });
       const embedding = embeddingRes.data[0].embedding;

       await supabase.from('tb_chunks').insert({
         post_id: post.id,
         url,
         title,
         content: chunkContent,
         embedding
       });
       totalChunks++;
    }
  }

  return new Response(JSON.stringify({ success: true, processed: posts.length, chunks: totalChunks }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
