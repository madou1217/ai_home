local US = string.char(31)
local rich = os.getenv("AIH_CLINK_DESCRIPTIONS") == "1"

local function quote(value)
    if value == nil or value == "" then return "" end
    if value:find("[%s\"]") then
        return '"' .. value:gsub('"', '\\"') .. '"'
    end
    return value
end

local g = clink.generator(10)
function g:generate(line_state, match_builder)
    local line = line_state:getline()
    local count = line_state:getwordcount()
    local cursor = line_state:getcursor()
    local offset = nil
    local ok, info = pcall(function() return line_state:getwordinfo(count) end)
    if ok and info and info.offset then offset = info.offset end
    local current = ""
    if offset and cursor >= offset then current = line:sub(offset, cursor) end
    local words = {}
    for i = 1, count - 1 do
        local w = line_state:getword(i)
        if w and w ~= "" then words[#words+1] = w end
    end
    if #words == 0 then return false end
    local base = (words[1]:match("([^\\/]+)$") or words[1]):lower()
    if base ~= "aih" and base ~= "aih.exe" then return false end
    table.remove(words, 1)
    local parts = { quote(aih_bin), "__complete" }
    if not rich then parts[#parts+1] = "--plain" end
    parts[#parts+1] = "--shell"
    parts[#parts+1] = "clink"
    parts[#parts+1] = "--current=" .. quote(current)
    parts[#parts+1] = "--"
    for _, w in ipairs(words) do parts[#parts+1] = quote(w) end
    local handle = io.popen(table.concat(parts, " ") .. " 2>nul")
    if not handle then return false end
    local output = handle:read("*a")
    handle:close()
    local added = 0
    for ln in output:gmatch("[^\r\n]+") do
        if rich then
            local value, desc = ln:match("^([^" .. US .. "]*)" .. US .. "([^" .. US .. "]*)")
            if value and value ~= "" then
                match_builder:addmatch({ match = value, description = desc or "", type = "word" })
                added = added + 1
            end
        else
            local value = ln:gsub("\r$", "")
            if value ~= "" then
                match_builder:addmatch({ match = value, type = "word" })
                added = added + 1
            end
        end
    end
    return added > 0
end
