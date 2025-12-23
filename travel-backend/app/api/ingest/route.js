import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';

export const maxDuration = 60; // Allow up to 60 seconds

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

  // Fetch 5 posts at a time to stay safe
  const wpRes = await fetch(`${process.env.WP_BASE_URL}/wp-json/wp/v2/posts?per_page=5&_fields=id,link,title,content`);
  const posts = await wpRes.json();
  
  let totalChunks = 0;

  for (const post of posts) {
    // 1. Clean up old data for this post
    await supabase.from('tb_chunks').delete().eq('post_id', post.id);

    const $ = cheerio.load(post.content.rendered);
    const title = post.title.rendered;
    const url = post.link;
    
    $('script').remove();
    $('style').remove();
    const cleanText = $('body').text().replace(/\s+/g, ' ').trim();

    const textChunks = chunkText(cleanText, 1500); 
    const rowsToInsert = [];

    // 2. Generate Embeddings (Parallel)
    // We create a list of promises to do them all at once
    const embeddingPromises = textChunks.map(async (chunkContent) => {
        const embeddingRes = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: chunkContent
        });
        const embedding = embeddingRes.data[0].embedding;
        
        // Add to our list
        rowsToInsert.push({
            post_id: post.id,
            url,
            title,
            content: chunkContent,
            embedding
        });
    });

    // Wait for all embeddings to finish
    await Promise.all(embeddingPromises);

    // 3. Bulk Insert (One database call instead of many)
    if (rowsToInsert.length > 0) {
        await supabase.from('tb_chunks').insert(rowsToInsert);
        totalChunks += rowsToInsert.length;
    }
  }

  return new Response(JSON.stringify({ success: true, processed: posts.length, chunks: totalChunks }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
