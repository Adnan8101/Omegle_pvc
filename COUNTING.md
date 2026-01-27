# 🔢 Counting System

A clean and simple counting game for your Discord server!

## Features

✅ **Sequential Counting** - Users count from 1, 2, 3... in order  
✅ **Auto-Validation** - Automatically checks if the number is correct  
✅ **Success Reactions** - Adds ✅ to correct counts  
✅ **Error Detection** - Deletes wrong messages and shows clean error  
✅ **Same User Prevention** - Users can't count twice in a row  
✅ **Clean UI** - Simple, short embeds  

## Commands

### `/counting enable`
- **Description:** Enable counting in a channel
- **Options:** 
  - `channel` - The text channel for counting
- **Example:** `/counting enable channel:#counting`

### `/counting disable`
- **Description:** Disable counting system
- **Example:** `/counting disable`

### `/counting show`
- **Description:** Show current counting status
- **Shows:** Status, channel, current count, next number
- **Example:** `/counting show`

### `/counting reset`
- **Description:** Reset counting back to 1
- **Example:** `/counting reset`

## How It Works

1. **Admin sets up:** Run `/counting enable` and pick a channel
2. **Users start counting:** First user types `1`, next user types `2`, etc.
3. **Correct count:** Bot reacts with ✅
4. **Wrong count:** Bot deletes the message and shows error:
   ```
   ❌ Wrong Count!
   
   @User broke the counting!
   Expected 11, but got 12
   
   Start from: 11
   ```
5. **Same user twice:** 
   ```
   ❌ Wrong Count!
   
   @User broke the counting!
   You can't count twice in a row!
   
   Start from: 10
   ```

## Rules

- Count in sequential order (1, 2, 3, 4...)
- One user can't count twice in a row
- Only numbers are counted (no text)
- Wrong numbers are deleted automatically
- Error message disappears after 5 seconds

## Examples

✅ **Correct:**
```
User1: 1  ✅
User2: 2  ✅
User1: 3  ✅
User3: 4  ✅
```

❌ **Wrong:**
```
User1: 1  ✅
User2: 3  ❌ (Expected 2)
```

❌ **Same User:**
```
User1: 1  ✅
User1: 2  ❌ (Can't count twice)
```

## Database

The system stores:
- Guild ID
- Channel ID
- Enabled status
- Current count
- Last user ID (to prevent same user counting twice)

## Permissions

Commands require: `Manage Channels` permission
