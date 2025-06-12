import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

// --- 1. SETUP: โหลด API Keys และข้อมูล ---
dotenv.config();

// ตรวจสอบว่ามี API Key หรือไม่
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

console.log("กำลังแปลงโครงสร้างข้อมูล (Data Transformation)...");

// --- 2. DATA TRANSFORMATION: แปลงข้อมูลดิบให้พร้อมใช้งาน ---

// ระดับพลังของ CPU
const cpuPowerLevels = {
    'i3': 3, 'ryzen 3': 3,
    'i5': 5, 'ryzen 5': 5,
    'ultra 5': 6,
    'i7': 7, 'ryzen 7': 7, 'ultra 7': 7,
    'i9': 9, 'ryzen 9': 9, 'ultra 9': 9
};

const getCpuLevel = (cpuString) => {
    if (!cpuString) return 0;
    const lowerCpu = cpuString.toLowerCase();
    for (const [key, value] of Object.entries(cpuPowerLevels)) {
        if (lowerCpu.includes(key)) return value;
    }
    return 0;
};

// **✅ FIXED**: รวมการแปลงข้อมูลให้สมบูรณ์ในที่เดียว
const dellProducts = Object.values(rawDellDatabase).map(product => {
  const parseNumeric = (str) => parseInt(str?.match(/\d+/)?.[0] || 0, 10);
  // **✅ ADDED**: ดึงขนาดหน้าจอมาเพิ่มตามคำแนะนำ
  const displaySize = parseFloat(product.specifications?.display?.size_inches) || 0; 

  return {
    model_name: product.model_name || "N/A", 
    max_ram_gb: parseNumeric(product.specifications?.memory?.max_configuration) || 0,
    display_size_inches: displaySize, // <-- เพิ่ม Property ขนาดหน้าจอ
    processor_options: product.specifications?.processor?.map(p => ({
        type: p.type,
        core_count: p.core_count,
        level: getCpuLevel(p.type)
    })) || [],
    available_os: product.specifications?.operating_systems || [],
    storage_options: product.specifications?.storage?.supported_drive_types?.map(s => s.type) || [],
    raw_specs: product.specifications
  };
});

console.log(`แปลงข้อมูลเสร็จสิ้น พบ ${dellProducts.length} โมเดลหลัก`);


// --- 3. RETRIEVAL Part 1: สกัดความต้องการจาก TOR ด้วย AI ---

// **✅ FIXED**: ปรับปรุง Prompt ให้สกัดข้อมูล "ขนาดหน้าจอ" ด้วย
const EXTRACTION_PROMPT = `
    จากข้อความ TOR ต่อไปนี้ ให้สกัดคุณสมบัติทางเทคนิคที่ต้องการสำหรับคอมพิวเตอร์
    แล้วแปลงให้อยู่ในรูปแบบ JSON ที่มี key ดังนี้: 
    - min_ram_gb (ตัวเลข)
    - min_storage_gb (ตัวเลข)
    - required_os (ข้อความหรือ Array ของข้อความ)
    - cpu_family (เช่น 'i5', 'Ryzen 5', 'Ultra 5')
    - cpu_model_string (ข้อความเฉพาะของรุ่น CPU ที่ระบุใน TOR เช่น '155H', '135U' หากไม่พบข้อมูลรุ่นที่ชัดเจน หรือไม่แน่ใจ ให้ใช้ค่า null เท่านั้น)
    - display (object ที่มี key 'size_inches' เป็นตัวเลข)

    สำหรับ required_os ให้สกัดเฉพาะชื่อหลักและเวอร์ชัน เช่น 'Windows 11 Pro', 'Ubuntu'. อย่าใส่คำว่า 'or later' หรือ 'Microsoft'.
    ถ้าไม่พบข้อมูลใดให้ใช้ค่า null

    TOR:
    ---
    %TOR_CONTENT%
    ---

    JSON Output:
  `;

async function extractRequirements(torContent) {
    console.log("\n[ขั้นตอนที่ 1] กำลังให้ AI ทั้งสองตัวสกัดความต้องการจาก TOR...");
    const prompt = EXTRACTION_PROMPT.replace('%TOR_CONTENT%', torContent);

    try {
        const [geminiReqResult, deepseekReqResult] = await Promise.all([
            genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).generateContent(prompt),
            deepseek.chat.completions.create({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }] })
        ]);

        const geminiText = geminiReqResult.response.text().replace(/```json|```/g, "").trim();
        const deepseekText = deepseekReqResult.choices[0].message.content.replace(/```json|```/g, "").trim();

        console.log("-> Gemini สกัดได้:", geminiText);
        console.log("-> DeepSeek สกัดได้:", deepseekText);

        return {
            gemini: JSON.parse(geminiText),
            deepseek: JSON.parse(deepseekText)
        };
    } catch (error) {
        console.error("เกิดข้อผิดพลาดในการสกัดข้อมูลจาก TOR:", error);
        const fallback = { min_ram_gb: null, min_storage_gb: null, required_os: null, cpu_family: null, cpu_model_string: null, display: null };
        return { gemini: fallback, deepseek: fallback };
    }
}

// --- 4. RETRIEVAL Part 2: กรองข้อมูลจาก Database ---
// --- 4. RETRIEVAL Part 2: กรองข้อมูลจาก Database (ฉบับปรับปรุงให้ยืดหยุ่นขึ้น) ---
function filterCandidates(allRequirements) {
    console.log("\n[ขั้นตอนที่ 2] กำลังกรองรุ่นที่เข้าข่ายจากฐานข้อมูล (แบบยืดหยุ่น)...");

    const filterBy = (requirements, sourceName) => {
        
        const candidates = dellProducts.filter(pc => {
            // 1. RAM Check (ยังคงเดิม)
            const ramMatch = pc.max_ram_gb >= (requirements.min_ram_gb || 0);

            // 2. OS Check (ยังคงเดิม)
            const osMatch = (() => {
                const { required_os } = requirements;
                if (!required_os || required_os.length === 0) return true;
                const requiredOsList = Array.isArray(required_os) ? required_os : [required_os];
                return pc.available_os.some(pcOs => {
                    const pcOsLower = pcOs.toLowerCase();
                    return requiredOsList.some(reqOs => {
                        const reqOsLower = (reqOs || '').toLowerCase();
                        if (!reqOsLower) return false;
                        const searchTerm = reqOsLower.includes('windows 11') ? 'windows 11' :
                                           reqOsLower.includes('ubuntu') ? 'ubuntu' : reqOsLower;
                        return pcOsLower.includes(searchTerm);
                    });
                });
            })();
            
            // 3. Storage Check (ยังคงเดิม)
            const storageMatch = (requirements.min_storage_gb && requirements.min_storage_gb > 0) 
                ? pc.storage_options.some(s => s.toLowerCase().includes('solid-state') || s.toLowerCase().includes('ssd')) 
                : true;

            // ✅ [IMPROVEMENT] 4. Display Size Check: ทำให้ยืดหยุ่นขึ้น
            const displayMatch = (() => {
                const requiredSize = requirements.display?.size_inches;
                if (!requiredSize) return true; 
                // เปลี่ยนจากการเช็คค่าตรงๆ (===) มาเป็นการเช็คช่วงที่ใกล้เคียง
                // เช่น ถ้าต้องการ 14 นิ้ว จะเจอทั้ง 13.9, 14.0, 14.1
                return Math.abs(pc.display_size_inches - requiredSize) <= 0.2;
            })();

            // ✅ [IMPROVEMENT] 5. CPU Check: ทำให้ฉลาดขึ้น
            const cpuMatch = (() => {
                if (!requirements.cpu_family) return true;

                const requiredCpuLevel = getCpuLevel(requirements.cpu_family);
                const requiredModelString = requirements.cpu_model_string;

                // ลองหา CPU ที่ตรงทั้ง Level และ Model ก่อน (เข้มงวด)
                const hasExactMatch = pc.processor_options.some(cpu => {
                    const levelCheck = cpu.level >= requiredCpuLevel;
                    if (!levelCheck) return false;

                    const modelCheck = (() => {
                        if (!requiredModelString) return true; 
                        const modelNumber = requiredModelString.match(/\d+/);
                        if (modelNumber) {
                            return cpu.type.toLowerCase().includes(modelNumber[0]);
                        }
                        return cpu.type.toLowerCase().includes(requiredModelString.toLowerCase());
                    })();

                    return modelCheck;
                });
                
                // ถ้าเจอตัวที่ตรงเป๊ะ ให้ใช้ผลลัพธ์นั้นเลย
                if(hasExactMatch) return true;

                // 💥 Fallback: ถ้าไม่เจอตัวตรงรุ่น ให้ถอยมาเช็คแค่ Level ก็พอ
                // เพื่อหา "รุ่นอื่น" ที่มีพลังใกล้เคียงกันมาเป็นตัวเลือก
                if (!requiredModelString) {
                    // ถ้า TOR ไม่ระบุรุ่นย่อย แต่หา Level ไม่เจอ แสดงว่าไม่ผ่าน
                    return pc.processor_options.some(cpu => cpu.level >= requiredCpuLevel);
                } else {
                    // ถ้า TOR ระบุรุ่นย่อยมา แต่หาไม่เจอ ให้ลองหาแค่ Level
                    console.log(`[INFO] รุ่น ${pc.model_name} ไม่มี CPU model '${requiredModelString}' แต่จะลองเช็คแค่ CPU level >= ${requiredCpuLevel} แทน`);
                    return pc.processor_options.some(cpu => cpu.level >= requiredCpuLevel);
                }

            })();

            return ramMatch && osMatch && cpuMatch && storageMatch && displayMatch;
        });
        console.log(`-> ${sourceName} พบ ${candidates.length} รุ่นที่เข้าข่าย`);
        return candidates;
    };
    
    const geminiCandidates = filterBy(allRequirements.gemini, "Gemini");
    const deepseekCandidates = filterBy(allRequirements.deepseek, "DeepSeek");

    const allCandidateModels = new Map();
    [...geminiCandidates, ...deepseekCandidates].forEach(c => {
        if (!allCandidateModels.has(c.model_name)) {
            allCandidateModels.set(c.model_name, c);
        }
    });
    
    return Array.from(allCandidateModels.values());
}

// --- 5. AUGMENT & GENERATE: สร้าง Prompt และเรียก AI ทั้งสองตัว ---
async function getInitialRecommendations(torContent, candidates) {
  if (candidates.length === 0) return null;

  const simplifiedCandidates = candidates.map(c => ({
      model_name: c.model_name,
      max_ram_gb: c.max_ram_gb,
      display_size_inches: c.display_size_inches, // ส่งขนาดจอให้ AI พิจารณาด้วย
      processor_options: c.processor_options.map(p => p.type),
      available_os: c.available_os
  }));

  const promptForRecommender = `
    **โจทย์ (TOR):**
    ${torContent}

    **รายการคอมพิวเตอร์ Dell ที่ผ่านเกณฑ์ขั้นต่ำ (Candidates):**
    ${JSON.stringify(simplifiedCandidates, null, 2)}

    **คำสั่ง:**
    คุณคือผู้เชี่ยวชาญด้านการจัดซื้อคอมพิวเตอร์ Presale Engineer
    จากรายการคอมพิวเตอร์ที่ให้มา จงวิเคราะห์และ "เลือกรุ่นที่ดีและคุ้มค่าที่สุดเพียง 1 รุ่น" ที่ตอบโจทย์ตาม TOR
    ให้คำตอบโดยระบุ "ชื่อรุ่น (model_name)" และ "เหตุผลประกอบการตัดสินใจ" อย่างชัดเจนและกระชับ
  `;
  
  console.log("\n[ขั้นตอนที่ 3] กำลังส่งข้อมูล 'เฉพาะรุ่นที่ผ่านการกรอง' ให้ AI สองตัวช่วยกันคิด...");
  console.log("⏳ กรุณารอ... กำลังประมวลผลจาก Gemini และ DeepSeek");
  
  const startTime = Date.now();

  try {
    const [geminiResult, deepseekResult] = await Promise.all([
      genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).generateContent(promptForRecommender),
      deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: promptForRecommender }],
      }),
    ]);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ ประมวลผลเบื้องต้นเสร็จสิ้นใน ${duration.toFixed(2)} วินาที`);

    return {
      gemini_recommendation: geminiResult.response.text(),
      deepseek_recommendation: deepseekResult.choices[0].message.content,
    };
  } catch (error) {
      console.error("เกิดข้อผิดพลาดระหว่างการเรียก API แนะนำ:", error.message);
      throw error;
  }
}

// --- 6. ARBITER: ให้ AI ช่วยตัดสินใจเลือกระหว่าง 2 คำตอบ ---
async function getFinalDecision(initialRecommendations, torContent) {
    console.log("\n[ขั้นตอนที่ 4] AI ทั้งสองมีความเห็นต่างกัน กำลังส่งให้ DeepSeek ช่วยตัดสินชี้ขาด...");

    const arbiterPrompt = `
        **โจทย์ตั้งต้น (Original TOR):**
        ${torContent}

        **สถานการณ์:**
        เราได้ให้ AI สองตัวช่วยกันเลือกรุ่นคอมพิวเตอร์ และนี่คือคำแนะนำจากทั้งสอง:

        ---
        **คำแนะนำที่ 1 (จาก Gemini):**
        ${initialRecommendations.gemini_recommendation}
        ---
        **คำแนะนำที่ 2 (จาก DeepSeek):**
        ${initialRecommendations.deepseek_recommendation}
        ---

        **ภารกิจของคุณ:**
        คุณคือหัวหน้าฝ่ายจัดซื้อที่มีอำนาจตัดสินใจสูงสุด
        จงวิเคราะห์คำแนะนำทั้งสองเทียบกับโจทย์ตั้งต้น (TOR) แล้ว "เลือกคำตอบที่ตรงและใกล้เคียงกับความต้องการใน TOR มากที่สุด" เพียงหนึ่งเดียว
        
        **รูปแบบคำตอบ:**
        ให้ระบุ "ชื่อรุ่นสุดท้ายที่เลือก" และ "สรุปเหตุผลที่เลือกคำตอบนี้" อย่างชัดเจน
    `;

    const result = await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: arbiterPrompt }],
    });
    console.log("✅ การตัดสินใจสิ้นสุด");
    return result.choices[0].message.content;
}


// --- 7. MAIN WORKFLOW: ประกอบทุกอย่างเข้าด้วยกัน ---
async function main() {
  try {
    const torPath = path.join(process.cwd(), "data", "tor.txt");
    const torContent = await fs.readFile(torPath, "utf-8");
    console.log("--- 🚀 เริ่มกระบวนการแนะนำคอมพิวเตอร์ (Cross-Validation + Arbiter) ---");

    const allRequirements = await extractRequirements(torContent);
    const candidates = filterCandidates(allRequirements);
    
    console.log(`\n-> กรองข้อมูลเสร็จสิ้น พบ ${candidates.length} รุ่นที่เข้าข่าย`);
    if (candidates.length > 0) {
        console.log("รุ่นที่เข้าข่าย:", candidates.map(c => c.model_name));
    }

    if (candidates.length > 0) {
        const initialRecs = await getInitialRecommendations(torContent, candidates);
        
        const geminiModelName = (initialRecs.gemini_recommendation.match(/ชื่อรุ่น(?:สุดท้ายที่เลือก)?:\s*(.*)/i) || [])[1];
        const deepseekModelName = (initialRecs.deepseek_recommendation.match(/ชื่อรุ่น(?:สุดท้ายที่เลือก)?:\s*(.*)/i) || [])[1];
        
        let finalAnswer;

        if (geminiModelName && deepseekModelName && geminiModelName.trim() === deepseekModelName.trim()) {
            console.log("\n[ขั้นตอนที่ 4] AI ทั้งสองเห็นตรงกัน!");
            finalAnswer = initialRecs.gemini_recommendation;
        } else {
            finalAnswer = await getFinalDecision(initialRecs, torContent);
        }

        console.log("\n\n--- 🌟 สรุปผลลัพธ์สุดท้าย (Final Decision) 🌟 ---");
        console.log(finalAnswer);

    } else {
        console.log("\n--- 🌟 ผลลัพธ์การแนะนำ 🌟 ---");
        console.log("\nไม่พบรุ่นคอมพิวเตอร์ที่ตรงตามเงื่อนไขใน TOR ของคุณ");
        console.log("💡 ข้อเสนอแนะ: ลองตรวจสอบว่าในฐานข้อมูล 'dellpro_laptop_desktop_merged.json' มีรุ่นที่ต้องการหรือไม่ หรือลองปรับแก้ TOR ให้ชัดเจนยิ่งขึ้น");
    }

    console.log("\n--- ✅ สิ้นสุดกระบวนการ ---");

  } catch (error) {
    console.error(`\n--- ❌ เกิดข้อผิดพลาดร้ายแรงในกระบวนการหลัก ---`);
    if (error.status === 429) {
        console.error("สาเหตุ: เครดิตหรือโควต้าการใช้งาน API หมดแล้ว");
        console.error("วิธีแก้ไข: กรุณาตรวจสอบแผนการใช้งานในบัญชีของคุณ");
    } else {
        console.error("รายละเอียดข้อผิดพลาด:", error.message);
    }
  }
}

main();