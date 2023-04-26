import { RequestHandler } from 'express'
import createHttpError, { HttpError } from 'http-errors'
import feedbackDataModel from '../data_models/feedbackData'
import { validateFeedbackData } from '../utils/validators'
import { AnswerScoreI, AnswerBySectionI, FeedbackDataI } from '../data_models/feedbackData'
import validator from 'validator'

export const getAll: RequestHandler = async (req, res, next) => {
  try {
    const toBeReviewedAll = await feedbackDataModel.find().lean().exec()
    res.status(200).json(toBeReviewedAll)
  } catch (error) {
    next(error)
  }
}

export const getFeedbackDataByRequestId: RequestHandler<{ requestid: string }> = async (
  req,
  res,
  next
) => {
  const requestId = validator.escape(req.params.requestid)
  try {
    const feedbackData = await feedbackDataModel.findOne({ requestId }).exec()
    res.status(200).json(feedbackData)
  } catch (error) {
    next(error)
  }
}

interface FeedbackRequestI {
  requestid: string
  employeeid: string
  sections: {
    sectionName: string
    questions: {
      score?: number
      openFeedback?: string
    }[]
  }[]
}

type ScoreAndOpenFeedback = {
  scores: number[]
  openFeedback: string[]
}

const calculateAverageScore = (scores: number[]): number =>
  scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

const extractScoresAndOpenFeedback = (
  questions: FeedbackRequestI['sections'][0]['questions']
): ScoreAndOpenFeedback =>
  questions.reduce<ScoreAndOpenFeedback>(
    (acc, question) => {
      if (question.score !== undefined) {
        acc.scores.push(question.score)
      }
      if (question.openFeedback !== undefined) {
        acc.openFeedback.push(question.openFeedback)
      }
      return acc
    },
    { scores: [], openFeedback: [] }
  )

const createAnswerScore = (section: FeedbackRequestI['sections'][0]): AnswerScoreI => {
  const { scores, openFeedback } = extractScoresAndOpenFeedback(section.questions)
  const averageScore = calculateAverageScore(scores)
  return { average: averageScore, openFeedback }
}

const createOrUpdateAnswerBySection = (
  answersBySection: AnswerBySectionI[],
  section: FeedbackRequestI['sections'][0],
  answerScore: AnswerScoreI
): AnswerBySectionI[] => {
  const existingSectionIndex = answersBySection.findIndex(
    (answerBySection) => answerBySection.sectionName === section.sectionName
  )

  if (existingSectionIndex !== -1) {
    answersBySection[existingSectionIndex].score.push(answerScore)
  } else {
    answersBySection.push({
      sectionName: section.sectionName,
      score: [answerScore],
    })
  }

  return answersBySection
}

const createAnswersBySection = (sections: FeedbackRequestI['sections']): AnswerBySectionI[] =>
  sections.reduce<AnswerBySectionI[]>((acc, section) => {
    const answerScore = createAnswerScore(section)
    return createOrUpdateAnswerBySection(acc, section, answerScore)
  }, [])

export const insertFeedbackData: RequestHandler<
  unknown,
  unknown,
  FeedbackRequestI,
  unknown
> = async (req, res, next) => {
  const { requestid, employeeid, sections } = req.body
  const sanitizedRequestId = validator.escape(requestid)
  const sanitizedEmployeeId = validator.escape(employeeid)

  if (!validateFeedbackData(requestid, employeeid, sections)) {
    return res.status(400).send('Invalid input data')
  }

  const answersBySection = createAnswersBySection(sections)

  try {
    const existingFeedbackData = await feedbackDataModel.findOne({ requestId: sanitizedRequestId })

    if (existingFeedbackData) {
      throw createHttpError(409, 'Feedback data with this requestid already exists')
    }

    const newFeedbackData: FeedbackDataI = {
      requestId: sanitizedRequestId,
      employeeId: sanitizedEmployeeId,
      answersBySection,
    }

    await feedbackDataModel.create(newFeedbackData)
    res.sendStatus(201)
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) {
      await updateFeedbackData(req, res, next)
    } else {
      next(error)
    }
  }
}

//Update feedback data
export const updateFeedbackData: RequestHandler<
  unknown,
  unknown,
  FeedbackRequestI,
  unknown
> = async (req, res, next) => {
  const { requestid, employeeid, sections } = req.body
  const sanitizedRequestId = validator.escape(requestid)
  const sanitizedEmployeeId = validator.escape(employeeid)

  if (!validateFeedbackData(requestid, employeeid, sections)) {
    return res.status(400).send('Invalid input data')
  }

  if (!sections || sections.length === 0) {
    return res.sendStatus(400)
  }

  const answersBySection = createAnswersBySection(sections)

  const newFeedbackData: FeedbackDataI = {
    requestId: sanitizedRequestId,
    employeeId: sanitizedEmployeeId,
    answersBySection,
  }

  try {
    const existingData = await feedbackDataModel.findOne({ requestId: newFeedbackData.requestId })

    if (!existingData) {
      throw createHttpError(404, 'Feedback data not found')
    }

    newFeedbackData.answersBySection.forEach((newSection) => {
      const { sectionName, score } = newSection
      const existingSection = existingData.answersBySection.find(
        (existingSection: { sectionName: string }) => existingSection.sectionName === sectionName
      )

      if (existingSection) {
        existingSection.score.push(...score)
      } else {
        existingData.answersBySection.push(newSection)
      }
    })

    await existingData.save()
    res.sendStatus(200)
  } catch (error) {
    next(error)
  }
}
