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
  const urlParams = new URL(req.url);
  const secret = urlParams.searchParams.get('secret');
  
  // Allow dynamic page and count from URL (Defaults: Page 1, 10 posts)
  const page = urlParams.searchParams.get('page') || '1';
  const perPage = urlParams.searchParams.get('per_page') || '10';

  if (secret !== INGEST_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  console.log(`Fetching Page ${page} with ${perPage} posts...`);

  // Fetch posts from WordPress with pagination
  const wpRes = await fetch(`${process.env.WP_BASE_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,link,title,content`);
  
  if (!wpRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch from WordPress. Check page number." }), { status: 400 });
  }

  const posts = await wpRes.json();
  
  // If empty, we reached the end
  if (posts.length === 0) {
    return new Response(JSON.stringify({ success: true, message: "No more posts found.", page: page }), { headers: { 'Content-Type': 'application/json' }});
  }

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
    const embeddingPromises = textChunks.map(async (chunkContent) => {
        const embeddingRes = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: chunkContent
        });
        const embedding = embeddingRes.data[0].embedding;
        
        rowsToInsert.push({
            post_id: post.id,
            url,
            title,
            content: chunkContent,
            embedding
        });
    });

    await Promise.all(embeddingPromises);

    // 3. Bulk Insert
    if (rowsToInsert.length > 0) {
        await supabase.from('tb_chunks').insert(rowsToInsert);
        totalChunks += rowsToInsert.length;
    }
  }

  return new Response(JSON.stringify({ 
    success: true, 
    page: page, 
    posts_processed: posts.length, 
    chunks_created: totalChunks 
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
