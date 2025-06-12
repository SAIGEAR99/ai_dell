import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

// --- SETUP & HELPER FUNCTIONS (เหมือนเดิม) ---
dotenv.config();
// ... (โค้ดส่วนนี้ทั้งหมดเหมือนเดิม) ...
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1"
});
const dellDatabasePath = path.join(process.cwd(), "data", "dellpro_laptop_desktop_merged.json");
const rawDellDatabase = JSON.parse(await fs.readFile(dellDatabasePath, "utf-8"));
console.log(`ฐานข้อมูลพร้อมใช้งาน, พบ ${Object.keys(rawDellDatabase).length} โมเดลทั้งหมด`);
async function extractHardRequirements(torContent) {
  console.log("\n[ด่านที่ 0.1] 🚀 กำลังสกัด 'กฎ' สำหรับการให้คะแนน...");
  const prompt = `
    จาก TOR ต่อไปนี้ ให้สกัดเฉพาะคุณสมบัติที่เป็นตัวเลขหรือค่าที่ชัดเจนสำหรับใช้ให้คะแนน
    - min_ram_gb (ตัวเลข)
    - cpu_family (ข้อความสั้นๆ เช่น "Core Ultra 5", "Ryzen 7")
    - gpu_required (boolean)
    - display_size_inches (ตัวเลข)
    - keywords (Array ของคำสำคัญอื่นๆ ที่ไม่ใช่ขนาดจอ)
    TOR: --- ${torContent} ---
    JSON Output:
  `;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
    const result = await model.generateContent(prompt);
    const requirements = JSON.parse(result.response.text().replace(/```json|```/g, "").trim());
    console.log("✅ ได้กฎสำหรับให้คะแนน:", JSON.stringify(requirements));
    return requirements;
  } catch (e) { console.error("❌ เกิดข้อผิดพลาดในการสกัดกฎ:", e); return null; }
}
function getScreenSizeFromName(modelName) {
    if (!modelName) return null;
    const match = modelName.match(/\b(13|14|15|16|24|27)\b/);
    return match ? parseInt(match[1], 10) : null;
}
function calculateMatchScore(pc, requirements) {
    let score = 0;
    const log = [];
    const specs = pc.specifications;
    if (!specs || !requirements) return { score: 0, log: ["No specs or requirements"] };
    const pcJsonString = JSON.stringify(pc).toLowerCase();
    if (requirements.display_size_inches) {
        const sizeFromName = getScreenSizeFromName(pc.model_name);
        if (sizeFromName && sizeFromName === requirements.display_size_inches) {
            score += 40; log.push(`+40: Screen(${sizeFromName}")`);
        } else { score -= 60; log.push(`-60: Screen mismatch (Req: ${requirements.display_size_inches}, Found: ${sizeFromName || 'N/A'})`); }
    }
    if (requirements.cpu_family) {
        if ((specs.processor || []).some(p => p.type.toLowerCase().includes(requirements.cpu_family.toLowerCase()))) {
            score += 50; log.push("+50: CPU");
        } else { score -= 50; log.push("-50: CPU"); }
    }
    if (requirements.min_ram_gb) {
        const pcMaxRam = parseInt(specs.memory?.max_configuration?.match(/\d+/)?.[0] || '0');
        if (pcMaxRam >= requirements.min_ram_gb) {
            score += 20; log.push("+20: RAM");
            const bonus = Math.min(20, (pcMaxRam / requirements.min_ram_gb - 1) * 10);
            if (bonus > 0) { score += bonus; log.push(`+${bonus.toFixed(0)}: RAM bonus`); }
        } else { score -= 30; log.push("-30: RAM"); }
    }
    const hasDiscreteGPU = !!specs.gpu?.discrete;
    if (requirements.gpu_required === true) {
        if (hasDiscreteGPU) { score += 15; log.push("+15: dGPU");
        } else { score -= 25; log.push("-25: dGPU"); }
    } else if (requirements.gpu_required === false) {
        if (hasDiscreteGPU) { score -= 10; log.push("-10: dGPU");
        } else { score += 5; log.push("+5: dGPU"); }
    }
    if (requirements.keywords?.length > 0) {
        let keywordMatches = 0;
        requirements.keywords.forEach(kw => {
            if (pcJsonString.includes(kw.toLowerCase())) {
                keywordMatches++; score += 5;
            }
        });
        if (keywordMatches > 0) { log.push(`+${keywordMatches * 5}: Keywords`); }
    }
    return { model_name: pc.model_name, score, log, pc };
}
async function aiRefinedFilter(torContent, candidates) {
    console.log(`\n[ด่านที่ 1] 🤖 กำลังกรองละเอียดด้วย Gemini 1.5 Flash (${candidates.length} รุ่น)...`);
    if (candidates.length === 0) return [];
    const NUM_TO_SELECT = 3;
    const prompt = `คุณคือ Presales Engineer ที่ได้รับรายการคอมพิวเตอร์ที่ผ่านการกรองเบื้องต้นมาแล้ว
      **TOR ลูกค้า:**
      ---
      ${torContent}
      ---
      **รายการคอมพิวเตอร์ (Candidates) พร้อมคะแนนความเข้ากันได้:**
      ${JSON.stringify(candidates.map(c => ({model_name: c.model_name, score: c.score, key: Object.keys(rawDellDatabase).find(key => rawDellDatabase[key].model_name === c.model_name)})))}
      
      **ข้อมูลสเปคเต็ม:**
      ${JSON.stringify(candidates.map(c => c.pc), null, 2)}
      
      **คำสั่ง:**
      วิเคราะห์และคัดเลือกรุ่นที่เกี่ยวข้องและเหมาะสมที่สุดกับ TOR จากลิสต์นี้
      **ผลลัพธ์ของคุณจะต้องเป็น JSON Array ที่มี "key" ของ ${NUM_TO_SELECT} รุ่นที่ดีที่สุด เรียงลำดับจากดีที่สุดไปน้อยที่สุด**
      หากมีรุ่นที่เหมาะสมน้อยกว่า ${NUM_TO_SELECT} รุ่น ให้เลือกเท่าที่มี แต่พยายามเลือกให้ได้ ${NUM_TO_SELECT} รุ่นเสมอ
      
      JSON Output:
    `;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json|```/g, "").trim();
        const modelKeys = JSON.parse(responseText);
        console.log(`✅ กรองละเอียดด้วย AI: เหลือ ${modelKeys.length} รุ่น`);
        return modelKeys.map(key => rawDellDatabase[key]).filter(Boolean);
    } catch (e) {
        console.error(`❌ เกิดข้อผิดพลาดในด่าน AI Refined Filter:`, e);
        return candidates.slice(0, 3).map(c => c.pc);
    }
}

// --- STAGE 2 & 3: CROSS-VALIDATION & ARBITRATION (แก้ไข getInitialRecommendations) ---
async function getInitialRecommendations(torContent, candidates) {
    console.log(`\n[ด่านที่ 2] 🕵️‍♂️ กำลังส่ง ${candidates.length} รุ่นสุดท้ายให้ AI 2 ตัวช่วยกันวิเคราะห์แบบมีหลักการ...`);

    // --- PROMPT ฉบับแก้ไขใหม่ ---
    const prompt = `
    คุณคือผู้เชี่ยวชาญด้านการจัดซื้อคอมพิวเตอร์ที่มีประสบการณ์สูง หน้าที่ของคุณคือเลือกรุ่นที่ดีที่สุด 1 รุ่นจากรายการนี้

    **หลักการในการตัดสินใจ (Decision Principles):**
    1.  **Hard Constraints:** คุณสมบัติทางกายภาพที่เปลี่ยนแปลงไม่ได้ เช่น **"ขนาดหน้าจอ"** ถือเป็นเงื่อนไขสำคัญที่สุด หาก TOR ระบุขนาดจอมา รุ่นที่ไม่ตรงตามขนาดจอจะถูกพิจารณาเป็นลำดับสุดท้าย
    2.  **Soft Constraints:** คุณสมบัติทางประสิทธิภาพ เช่น "รุ่น CPU" หรือ "ความเร็ว RAM" สามารถยืดหยุ่นได้ หากมีรุ่นอื่นที่ประสิทธิภาพใกล้เคียงหรือดีกว่า ก็สามารถยอมรับได้
    3.  **Holistic View:** พิจารณาภาพรวมทั้งหมด อย่าให้น้ำหนักกับคุณสมบัติใดคุณสมบัติหนึ่งมากจนเกินไปจนมองข้ามข้อบกพร่องร้ายแรงในด้านอื่น

    **โจทย์ (TOR):**
    ---
    ${torContent}
    ---

    **ตัวเลือก (Candidates):**
    ${JSON.stringify(candidates.map(c=>c.model_name))}
    ---
    
    **ข้อมูลสเปคเต็ม:**
    ${JSON.stringify(candidates, null, 2)}
    ---

    **คำสั่ง:**
    จงวิเคราะห์ตามหลักการข้างต้น แล้วเลือกรุ่นที่ดีที่สุดมา 1 รุ่น พร้อมอธิบายเหตุผลอย่างละเอียดว่าทำไมถึงเลือกรุ่นนี้ และทำไมรุ่นอื่นถึงเหมาะสมน้อยกว่า

    **รูปแบบคำตอบ:**
    ชื่อรุ่น: [Model Name]
    เหตุผล: [Your detailed reasoning, explaining how you prioritized the requirements]`;
    
    const [geminiResult, deepseekResult] = await Promise.all([
      genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }).generateContent(prompt),
      deepseek.chat.completions.create({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }] }),
    ]);
    console.log("✅ AI ทั้งสองวิเคราะห์เสร็จสิ้น");
    return {
      gemini_recommendation: geminiResult.response.text(),
      deepseek_recommendation: deepseekResult.choices[0].message.content,
    };
}

async function getFinalDecision(initialRecommendations, torContent) {
    // ฟังก์ชันนี้เหมือนเดิม แต่จะได้รับ Input ที่มีคุณภาพมากขึ้น
    console.log("\n[ด่านที่ 3] 🏛️ AI เห็นต่างกัน! กำลังส่งให้ DeepSeek ช่วยตัดสินชี้ขาด...");
    const arbiterPrompt = `คุณคือหัวหน้าฝ่ายจัดซื้อ จงวิเคราะห์คำแนะนำทั้งสองเทียบกับ TOR แล้ว "เลือกคำตอบที่ตรงและใกล้เคียงที่สุด" เพียงหนึ่งเดียว.
        TOR: ${torContent}
        ---
        คำแนะนำที่ 1 (จาก Gemini):
        ${initialRecommendations.gemini_recommendation}
        ---
        คำแนะนำที่ 2 (จาก DeepSeek):
        ${initialRecommendations.deepseek_recommendation}
        ---
        รูปแบบคำตอบ: ให้ระบุ "ชื่อรุ่นสุดท้ายที่เลือก" และ "สรุปเหตุผล"`;
    const result = await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: arbiterPrompt }],
    });
    console.log("✅ การตัดสินใจสิ้นสุด");
    return result.choices[0].message.content;
}

/**
 * Main Orchestrator
 */
async function main() {
  try {
    const torPath = path.join(process.cwd(), "data", "tor.txt");
    const torContent = await fs.readFile(torPath, "utf-8");
    console.log("--- 🚀 เริ่มกระบวนการ RAG แบบ Smart Scoring (v4) ---");

    const requirements = await extractHardRequirements(torContent);
    if (!requirements) return;
    
    console.log("\n[ด่านที่ 0.2] 📈 กำลังคำนวณคะแนนและจัดอันดับทุกรุ่น...");
    const allScoredModels = Object.values(rawDellDatabase).map(pc => calculateMatchScore(pc, requirements));
    allScoredModels.sort((a, b) => b.score - a.score);

    const TOP_N_CANDIDATES = 6;
    let candidates = allScoredModels.slice(0, TOP_N_CANDIDATES);

    if (candidates.length === 0 || candidates[0].score <= 0) { 
        console.log("\nไม่พบรุ่นที่ได้คะแนนเป็นบวกเลย, อาจต้องปรับปรุง TOR หรือกฎการให้คะแนน"); 
        return; 
    }
    console.log(`✅ คำนวณคะแนนเสร็จสิ้น, คัด ${TOP_N_CANDIDATES} อันดับแรก:`);
    candidates.forEach((c, index) => {
        console.log(`   #${index + 1}: ${c.model_name} (Score: ${c.score}, Log: [${c.log.join(' | ')}])`);
    });

    let finalCandidates = await aiRefinedFilter(torContent, candidates);
    if (finalCandidates.length === 0) { 
        console.log("\nAI ไม่สามารถคัดเลือกรุ่นที่เหมาะสมได้, ใช้ Top 3 จาก Score แทน...");
        finalCandidates = candidates.slice(0, 3).map(c => c.pc);
    }
    console.log("รุ่นที่ผ่านด่าน 1 (Final Candidates):", finalCandidates.map(c => c.model_name));
    
    const initialRecs = await getInitialRecommendations(torContent, finalCandidates);
    const extractModelName = (recommendation) => (recommendation.match(/ชื่อรุ่น:\s*(.*)/i) || [])[1]?.trim();
    const geminiModelName = extractModelName(initialRecs.gemini_recommendation);
    const deepseekModelName = extractModelName(initialRecs.deepseek_recommendation);
    
    let finalAnswer;
    
    if (geminiModelName && deepseekModelName && geminiModelName === deepseekModelName) {
        console.log("\n[ด่านที่ 3] ✅ AI ทั้งสองเห็นตรงกัน!");
        finalAnswer = `**ผลการวิเคราะห์เป็นเอกฉันท์:**\n\n${initialRecs.gemini_recommendation}`;
    } else {
        finalAnswer = await getFinalDecision(initialRecs, torContent);
    }

    console.log("\n\n--- 🌟 สรุปผลลัพธ์สุดท้าย (Final Decision) 🌟 ---");
    console.log(finalAnswer);

  } catch (error) {
    console.error(`\n--- ❌ เกิดข้อผิดพลาดร้ายแรงในกระบวนการหลัก ---`, error);
  } finally {
    console.log("\n--- ✅ สิ้นสุดกระบวนการ ---");
  }
}

main();