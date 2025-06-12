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


// --- 2. RETRIEVAL STAGE: ให้ Gemini คัดกรองรุ่นที่เกี่ยวข้อง ---
/**
 * ใช้ Gemini เพื่อกรองรุ่นที่อาจเข้าข่ายจากฐานข้อมูลทั้งหมด (The "R" in RAG)
 * @param {string} torContent - เนื้อหาของ TOR
 * @param {object} database - ฐานข้อมูลคอมพิวเตอร์ทั้งหมด
 * @returns {Promise<string[]>} - Array ของ model keys ที่เกี่ยวข้อง
 */
async function geminiPreFilter(torContent, database) {
  console.log("\n[ขั้นตอนที่ 1] 🚀 เริ่มการค้นหาข้อมูล (Retrieval) โดย Gemini...");

  const preFilterPrompt = `
    คุณคือผู้เชี่ยวชาญ Presales Engineer ของ Dell หน้าที่ของคุณคือวิเคราะห์ TOR ของลูกค้าและคัดกรองรุ่นคอมพิวเตอร์ที่เกี่ยวข้องจากฐานข้อมูลทั้งหมด

    **TOR ของลูกค้า:**
    ---
    ${torContent}
    ---

    **ฐานข้อมูล Dell ทั้งหมด (JSON):**
    ${JSON.stringify(database, null, 2)}

    **คำสั่ง:**
    1.  อ่านและทำความเข้าใจ TOR อย่างละเอียด
    2.  วิเคราะห์คอมพิวเตอร์แต่ละรุ่นในฐานข้อมูล JSON ที่ให้มา
    3.  **ค้นหาและเลือกรุ่นคอมพิวเตอร์ทั้งหมด** ที่มีความเป็นไปได้ว่าจะตรงตาม TOR ไม่ว่าจะเป็นคุณสมบัติหลัก เช่น CPU, RAM, Storage, Form Factor (Laptop/Desktop/Rugged), หรือคุณสมบัติพิเศษที่ระบุไว้ใน TOR (เช่น Magnesium chassis, Fingerprint,
        ใส่ Sim card ได้)
    4.  เป้าหมายคือการสร้าง "รายการตัวเลือกเบื้องต้น" (candidate list) เพื่อให้ทีมวิเคราะห์ในขั้นตอนต่อไป ไม่ใช่การตัดสินใจเลือกรุ่นที่ดีที่สุดในขั้นตอนนี้
    5.  ผลลัพธ์ของคุณต้องเป็น JSON Array ของ "keys" ของรุ่นที่เลือกเท่านั้น (เช่น "DellPro14_PC14250", "DellPro14Premium_PA14250")

    **สำคัญมาก:**
    - ผลลัพธ์ต้องเป็น JSON Array ที่ถูกต้องสมบูรณ์เท่านั้น
    - ห้ามมีข้อความอธิบาย, หมายเหตุ, หรือ markdown formatting ใดๆ นอกเหนือจาก JSON Array

    JSON Output:
  `;
  
  // ใช้ 'gemini-1.5-flash-latest' ซึ่งเหมาะกับงานที่ต้องการความเร็วและจัดการข้อมูลขนาดใหญ่ และมีโควต้าฟรีที่สูงกว่า
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); 
  
  try {
    const result = await model.generateContent(preFilterPrompt);
    const responseText = result.response.text().replace(/```json|```/g, "").trim();
    
    const modelKeys = JSON.parse(responseText);
    console.log(`✅ Gemini ค้นหาและคัดเลือกรุ่นที่เกี่ยวข้องมาได้ ${modelKeys.length} รุ่น`);
    return modelKeys;
  } catch (error) {
    console.error("❌ เกิดข้อผิดพลาดร้ายแรงระหว่างการ Retrieval โดย Gemini:", error);
    console.log("-> ไม่สามารถแปลงผลลัพธ์จาก Gemini เป็น JSON Array ได้ จะคืนค่าเป็น Array ว่างเปล่า");
    return [];
  }
}

// --- 3. GENERATION STAGE: ให้ DeepSeek จัดอันดับจากข้อมูลที่ถูกเสริม (Augmented) ---
/**
 * ใช้ DeepSeek เพื่อวิเคราะห์และจัดอันดับ 2 รุ่นที่ดีที่สุดจากรายการที่กรองมาแล้ว (The "G" in RAG)
 * @param {string} torContent - เนื้อหาของ TOR
 * @param {object[]} candidates - Array ของข้อมูลรุ่นที่ผ่านการกรองมาแล้ว (พร้อม full specs)
 * @returns {Promise<string>} - JSON string ที่มีผลการจัดอันดับ
 */
async function deepseekFinalRanker(torContent, candidates) {
  console.log(`\n[ขั้นตอนที่ 2] 🏆 ส่ง ${candidates.length} รุ่นที่ผ่านการกรองให้ DeepSeek เพื่อทำการวิเคราะห์และสร้างคำตอบ (Generation)...`);
  
  const candidateData = {};
  candidates.forEach(c => {
    // ใช้ model_name ที่ไม่ซ้ำกันเป็น key
    const uniqueKey = Object.keys(rawDellDatabase).find(key => rawDellDatabase[key].model_name === c.model_name);
    if(uniqueKey) {
        candidateData[uniqueKey] = c;
    }
  });

  const arbiterPrompt = `
    **บทบาท:**
    คุณคือหัวหน้าฝ่ายจัดซื้อ (Chief Procurement Officer) ที่มีอำนาจในการตัดสินใจสูงสุด ภารกิจของคุณคือการเลือกคอมพิวเตอร์ 2 รุ่นที่ดีที่สุดสำหรับองค์กร

    **โจทย์ (TOR):**
    ---
    ${torContent}
    ---

    **บริบทเสริม (Augmented Context):**
    นี่คือข้อมูลจำเพาะ (specifications) ของรุ่นที่ AI ขั้นต้นได้คัดกรองมาให้แล้วว่ามีความเกี่ยวข้องกับ TOR มากที่สุด:
    ---
    ${JSON.stringify(candidateData, null, 2)}
    ---

    **คำสั่ง:**
    1.  **วิเคราะห์เชิงลึก:** เปรียบเทียบคุณสมบัติของคอมพิวเตอร์ "แต่ละรุ่น" ในบริบทเสริม กับ "แต่ละข้อ" ใน TOR อย่างละเอียด
    2.  **ให้คะแนน:** ประเมินว่าแต่ละรุ่นตอบโจทย์ TOR ได้ดีแค่ไหน ทั้งในแง่คุณสมบัติที่ตรงตามข้อกำหนด, เกินข้อกำหนด, หรือขาดหายไป
    3.  **จัดอันดับ:** เลือก 2 รุ่นที่ดีที่สุดและเหมาะสมที่สุดตามลำดับ
        - **อันดับที่ 1:** รุ่นที่ตรงตาม TOR มากที่สุดและคุ้มค่าที่สุด
        - **อันดับที่ 2:** รุ่นที่เป็นตัวเลือกสำรองที่ดีที่สุด
    4.  **ให้เหตุผล:** สำหรับแต่ละอันดับ ให้สรุปเหตุผลที่เลือกอย่างชัดเจนและกระชับ ว่าทำไมถึงเหมาะสมกับ TOR

    **รูปแบบผลลัพธ์ (สำคัญมาก):**
    ผลลัพธ์สุดท้ายของคุณต้องเป็น JSON object ที่ถูกต้องสมบูรณ์ ตามโครงสร้างนี้เท่านั้น ห้ามมีข้อความหรือ markdown อื่นๆ ปนมาเด็ดขาด

    {
      "rank_1": {
        "model_name": "ชื่อรุ่นอันดับ 1",
        "reason": "สรุปเหตุผลที่เลือกรุ่นนี้เป็นอันดับ 1 โดยอ้างอิงกับ TOR"
      },
      "rank_2": {
        "model_name": "ชื่อรุ่นอันดับ 2",
        "reason": "สรุปเหตุผลที่เลือกรุ่นนี้เป็นอันดับ 2 และจุดที่อาจด้อยกว่าอันดับ 1"
      }
    }

    JSON Output:
  `;
  
  const result = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: arbiterPrompt }],
      response_format: { type: "json_object" } // ใช้ JSON mode เพื่อความแน่นอน
  });
  console.log("✅ DeepSeek ทำการวิเคราะห์และจัดอันดับเสร็จสิ้น");
  return result.choices[0].message.content;
}


/**
 * Main Function
 */
async function main() {
  try {
    const torPath = path.join(process.cwd(), "data", "tor.txt");
    const torContent = await fs.readFile(torPath, "utf-8");
    console.log("--- 🚀 เริ่มกระบวนการ RAG (Gemini Retrieval -> DeepSeek Generation) ---");

    // ขั้นตอนที่ 1: Retrieval
    const relevantModelKeys = await geminiPreFilter(torContent, rawDellDatabase);

    if (!relevantModelKeys || relevantModelKeys.length === 0) {
        console.log("\n--- 🌟 ผลลัพธ์ ---");
        console.log("ไม่พบรุ่นคอมพิวเตอร์ที่เกี่ยวข้องตามการกรองของ Gemini");
        console.log("💡 ข้อเสนอแนะ: อาจเป็นเพราะไม่มีรุ่นในฐานข้อมูลที่ตรงกับ TOR หรือ Prompt สำหรับ Gemini ต้องได้รับการปรับปรุง");
        return;
    }

    // ขั้นตอนที่ 2: Augmentation - สร้าง list ของ candidates จาก keys ที่ได้มา
    const candidates = relevantModelKeys
      .map(key => rawDellDatabase[key])
      .filter(Boolean); 

    console.log("\nรุ่นที่ Gemini ค้นหาและส่งต่อให้ DeepSeek:", candidates.map(c => c.model_name));

    // ขั้นตอนที่ 3: Generation
    const finalDecisionJson = await deepseekFinalRanker(torContent, candidates);
    
    const finalDecision = JSON.parse(finalDecisionJson);

    console.log("\n\n--- 🌟 สรุปผลลัพธ์สุดท้ายจากการจัดอันดับโดย DeepSeek 🌟 ---\n");
    console.log(`🏆 อันดับที่ 1: ${finalDecision.rank_1.model_name}`);
    console.log(`   เหตุผล: ${finalDecision.rank_1.reason}\n`);
    console.log(`🥈 อันดับที่ 2: ${finalDecision.rank_2.model_name}`);
    console.log(`   เหตุผล: ${finalDecision.rank_2.reason}`);
    console.log("\n--------------------------------------------------------");

  } catch (error) {
    console.error(`\n--- ❌ เกิดข้อผิดพลาดร้ายแรงในกระบวนการหลัก ---`);
    if (error instanceof OpenAI.APIError && error.status === 429) {
        console.error("สาเหตุ: เครดิตหรือโควต้าการใช้งาน DeepSeek API หมดแล้ว");
    } else if (error.message.includes("rate limit")) {
        console.error("สาเหตุ: เครดิตหรือโควต้าการใช้งาน Gemini API หมดแล้ว หรือเรียกใช้งานถี่เกินไป");
    } else {
        console.error("รายละเอียดข้อผิดพลาด:", error);
    }
  } finally {
    console.log("\n--- ✅ สิ้นสุดกระบวนการ ---");
  }
}

main();