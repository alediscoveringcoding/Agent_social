// node --import ./test/register.mjs: module hooks for the test runner (see hooks.mjs).
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
