// index.js
import OpenAI from "openai";

const deepseekApiKey = "sk-3215753785cf4198879d1de9a424df28"; // แทนที่ด้วย DeepSeek API Key ของคุณ

const client = new OpenAI({
    apiKey: deepseekApiKey,
    baseURL: "https://api.deepseek.com", // กำหนด baseURL ให้ชี้ไปที่ DeepSeek API
});

async function testDeepSeekChat() {
    try {
        const completion = await client.chat.completions.create({
            model: "deepseek-chat", // หรือ "deepseek-reasoner"
            messages: [
                { role: "system", content: "คุณคือผู้ช่วยที่เป็นประโยชน์" },
                { role: "user", content: "สวัสดี DeepSeek! คุณทำอะไรได้บ้าง?" }
            ],
            temperature: 0.7, // สามารถปรับค่าได้
            max_tokens: 150,  // สามารถปรับค่าได้
        });

        console.log(completion.choices[0].message.content);
    } catch (error) {
        console.error("เกิดข้อผิดพลาดในการเรียก DeepSeek API:", error);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }
    }
}

testDeepSeekChat();