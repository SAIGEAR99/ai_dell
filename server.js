import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

// --- 1. SETUP: โหลด API Keys และข้อมูล ---
dotenv.config();

if (!process.env.GEMINI_API_KEY || !process.env.DEEPSEEK_API_KEY) {
  console.error("Error: กรุณาตั้งค่า GEMINI_API_KEY และ DEEPSEEK_API_KEY ในไฟล์ .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1"
});

const dellDatabasePath = path.join(process.cwd(), "data", "dellpro_laptop_desktop_merged.json");
const rawDellDatabase = JSON.parse(await fs.readFile(dellDatabasePath, "utf-8"));
console.log(`ฐานข้อมูลพร้อมใช้งาน, พบ ${Object.keys(rawDellDatabase).length} โมเดลทั้งหมด`);


// --- STAGE 0: HARDWARE REQUIREMENT EXTRACTION & PROGRAMMATIC FILTER ---
async function extractHardRequirements(torContent) {
  console.log("\n[ด่านที่ 0.1] 🚀 กำลังสกัด 'กฎ' สำหรับการกรองด้วยโค้ด...");
  const prompt = `
    จาก TOR ต่อไปนี้ ให้สกัดเฉพาะคุณสมบัติที่เป็นตัวเลขหรือค่าที่ชัดเจนสำหรับใช้กรองข้อมูลเบื้องต้น
    - min_ram_gb (ตัวเลข)
    - min_storage_gb (ตัวเลข)
    - cpu_family (ข้อความสั้นๆ เช่น "Core Ultra 5", "Ryzen 7")
    - display_size_inches (ตัวเลข)
    - gpu_required (boolean, true ถ้ามีการระบุการ์ดจอแยก)
    - keywords (Array ของคำสำคัญอื่นๆ เช่น ["magnesium", "sim card", "fingerprint"])
    หากไม่พบให้ใช้ null หรือ false.
    TOR: --- ${torContent} ---
    JSON Output:
  `;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
    const result = await model.generateContent(prompt);
    const requirements = JSON.parse(result.response.text().replace(/```json|```/g, "").trim());
    console.log("✅ ได้กฎสำหรับกรอง:", JSON.stringify(requirements));
    return requirements;
  } catch (e) {
    console.error("❌ เกิดข้อผิดพลาดในการสกัดกฎ:", e);
    return null;
  }
}

function programmaticFilter(requirements, database) {
  console.log("\n[ด่านที่ 0.2] ⚙️  กำลังกรองด้วยโค้ด (ไม่ใช้ Token)...");
  if (!requirements) return Object.values(database);
  
  const candidates = Object.values(database).filter(pc => {
    const specs = pc.specifications;
    if (!specs) return false;

    if (requirements.min_ram_gb && (parseInt(specs.memory?.max_configuration?.match(/\d+/)?.[0] || '0') < requirements.min_ram_gb)) return false;
    if (requirements.gpu_required === true && !specs.gpu?.discrete) return false;
    if (requirements.cpu_family && !(specs.processor || []).some(p => p.type.toLowerCase().includes(requirements.cpu_family.toLowerCase()))) return false;
    if (requirements.keywords?.length > 0) {
        const pcJsonString = JSON.stringify(pc).toLowerCase();
        if (!requirements.keywords.every(kw => pcJsonString.includes(kw.toLowerCase()))) return false;
    }
    return true;
  });

  console.log(`✅ กรองด้วยโค้ด: จาก ${Object.keys(database).length} เหลือ ${candidates.length} รุ่น`);
  return candidates;
}

// --- STAGE 1 & 2: AI-ASSISTED FILTERING (REUSABLE FUNCTION) ---
async function aiFilter(torContent, candidates, modelName, stageName) {
    console.log(`\n[${stageName}] 🤖 กำลังกรองด้วย ${modelName} (${candidates.length} รุ่น)...`);
    if (candidates.length === 0) return [];

    const prompt = `
      คุณคือ Presales Engineer ที่ได้รับรายการคอมพิวเตอร์ที่ผ่านการกรองเบื้องต้นมาแล้ว
      **TOR ลูกค้า:**
      ---
      ${torContent}
      ---
      **รายการคอมพิวเตอร์ (Candidates):**
      ${JSON.stringify(candidates.map(c => ({model_name: c.model_name, key: Object.keys(rawDellDatabase).find(key => rawDellDatabase[key].model_name === c.model_name)})))}
      
      **ข้อมูลสเปคเต็ม:**
      ${JSON.stringify(candidates, null, 2)}
      
      **คำสั่ง:**
      วิเคราะห์และคัดเลือกรุ่นที่ยังคงมีความเกี่ยวข้องกับ TOR มากที่สุด
      ผลลัพธ์ต้องเป็น JSON Array ของ "key" ของรุ่นที่เลือกเท่านั้น
      
      JSON Output:
    `;

    try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json|```/g, "").trim();
        const modelKeys = JSON.parse(responseText);
        console.log(`✅ ${stageName}: เหลือ ${modelKeys.length} รุ่น`);
        return modelKeys.map(key => rawDellDatabase[key]).filter(Boolean);
    } catch (e) {
        console.error(`❌ เกิดข้อผิดพลาดใน ${stageName}:`, e);
        return candidates; // ถ้า error ให้ส่งของเดิมกลับไป
    }
}


// --- STAGE 3 & 4: CROSS-VALIDATION & ARBITRATION ---
async function getInitialRecommendations(torContent, candidates) {
    console.log(`\n[ด่านที่ 3] 🕵️‍♂️ กำลังส่ง ${candidates.length} รุ่นสุดท้ายให้ AI 2 ตัวช่วยกันวิเคราะห์...`);
    // ... (โค้ดฟังก์ชันนี้เหมือนเดิม ไม่ต้องแก้ไข) ...
    const prompt = `คุณคือผู้เชี่ยวชาญที่ต้องเลือกรุ่นที่ดีที่สุด 1 รุ่นจากรายการนี้ ให้ตรงตาม TOR มากที่สุด:
    TOR: ${torContent}
    Candidates: ${JSON.stringify(candidates.map(c=>c.model_name))}
    ข้อมูลเต็ม: ${JSON.stringify(candidates, null, 2)}
    
    รูปแบบคำตอบ:
    ชื่อรุ่น: [Model Name]
    เหตุผล: [Your reason]`;

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
    console.log("\n[ด่านที่ 4] 🏛️ AI เห็นต่างกัน! กำลังส่งให้ DeepSeek ช่วยตัดสินชี้ขาด...");
    // ... (โค้ดฟังก์ชันนี้เหมือนเดิม ไม่ต้องแก้ไข) ...
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
    console.log("--- 🚀 เริ่มกระบวนการ RAG แบบ Ultimate 5-Stage ---");

    // ด่านที่ 0
    const hardRequirements = await extractHardRequirements(torContent);
    let candidates = programmaticFilter(hardRequirements, rawDellDatabase);
    if (candidates.length === 0) { console.log("ไม่พบรุ่นที่ผ่านการกรองด้วยโค้ด"); return; }
    console.log("รุ่นที่ผ่านด่าน 0:", candidates.map(c => c.model_name));

    // ด่านที่ 1
    candidates = await aiFilter(torContent, candidates, "gemini-1.0-pro", "ด่านที่ 1: Broad AI Filter");
    if (candidates.length === 0) { console.log("ไม่พบรุ่นที่ผ่านการกรองด้วย Gemini 1.0 Pro"); return; }
    console.log("รุ่นที่ผ่านด่าน 1:", candidates.map(c => c.model_name));
    
    // ด่านที่ 2
    candidates = await aiFilter(torContent, candidates, "gemini-1.5-flash-latest", "ด่านที่ 2: Refined AI Filter");
    if (candidates.length === 0) { console.log("ไม่พบรุ่นที่ผ่านการกรองด้วย Gemini 1.5 Flash"); return; }
    console.log("รุ่นที่ผ่านด่าน 2 (Final Candidates):", candidates.map(c => c.model_name));

    // ด่านที่ 3
    const initialRecs = await getInitialRecommendations(torContent, candidates);
    const extractModelName = (recommendation) => (recommendation.match(/ชื่อรุ่น:\s*(.*)/i) || [])[1]?.trim();
    const geminiModelName = extractModelName(initialRecs.gemini_recommendation);
    const deepseekModelName = extractModelName(initialRecs.deepseek_recommendation);
    
    let finalAnswer;

    // ด่านที่ 4
    if (geminiModelName && deepseekModelName && geminiModelName === deepseekModelName) {
        console.log("\n[ด่านที่ 4] ✅ AI ทั้งสองเห็นตรงกัน!");
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